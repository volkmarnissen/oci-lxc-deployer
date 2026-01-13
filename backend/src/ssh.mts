import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import path from "path";
import { ISsh } from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { spawnSync } from "child_process";

/**
 * Generate SSH key pair for the lxc user if it doesn't exist
 */
function generateSshKeyForLxcUser(): string | null {
  // Determine the home directory for the lxc user
  const envServiceHome = process.env.LXC_MANAGER_USER_HOME;
  const serviceHomes = envServiceHome 
    ? [envServiceHome] 
    : ["/var/lib/lxc-manager", "/home/lxc-manager", "/home/lxc"];
  
  // Try to find an existing home directory or use the first one
  let serviceHome: string | null = null;
  for (const h of serviceHomes) {
    try {
      if (existsSync(h)) {
        serviceHome = h;
        break;
      }
    } catch {}
  }
  
  // If no existing home found, try to create the first one
  if (!serviceHome) {
    const firstHome = serviceHomes[0];
    if (!firstHome) {
      // Fall back to current user's home
      const currentHome = process.env.HOME || homedir();
      if (!currentHome) {
        return null;
      }
      serviceHome = currentHome;
    } else {
      try {
        mkdirSync(firstHome, { recursive: true, mode: 0o755 });
        serviceHome = firstHome;
      } catch {
        // If we can't create the directory, fall back to current user's home
        const currentHome = process.env.HOME || homedir();
        if (!currentHome) {
          return null;
        }
        serviceHome = currentHome;
      }
    }
  }

  // At this point, serviceHome should always be a string
  if (!serviceHome) {
    return null;
  }

  const sshDir = path.join(serviceHome, ".ssh");
  const privateKeyPath = path.join(sshDir, "id_ed25519");
  const publicKeyPath = path.join(sshDir, "id_ed25519.pub");

  // Check if key already exists
  if (existsSync(publicKeyPath)) {
    try {
      const key = readFileSync(publicKeyPath, "utf-8").trim();
      if (key.length > 0) return key;
    } catch {}
  }

  // Generate new key pair
  try {
    // Ensure .ssh directory exists
    if (!existsSync(sshDir)) {
      mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    }

    // Generate ed25519 key (preferred, more secure and faster)
    const keygenResult = spawnSync(
      "ssh-keygen",
      [
        "-t", "ed25519",
        "-f", privateKeyPath,
        "-N", "", // No passphrase
        "-C", "lxc-manager@auto-generated"
      ],
      { encoding: "utf-8", timeout: 10000 }
    );

    if (keygenResult.status === 0 && existsSync(publicKeyPath)) {
      // Set proper permissions
      try {
        chmodSync(privateKeyPath, 0o600);
        chmodSync(publicKeyPath, 0o644);
      } catch {}
      
      const key = readFileSync(publicKeyPath, "utf-8").trim();
      if (key.length > 0) return key;
    }
  } catch (err: any) {
    // If ed25519 fails, try RSA as fallback
    try {
      const rsaPrivateKeyPath = path.join(sshDir, "id_rsa");
      const rsaPublicKeyPath = path.join(sshDir, "id_rsa.pub");
      
      const keygenResult = spawnSync(
        "ssh-keygen",
        [
          "-t", "rsa",
          "-b", "4096",
          "-f", rsaPrivateKeyPath,
          "-N", "", // No passphrase
          "-C", "lxc-manager@auto-generated"
        ],
        { encoding: "utf-8", timeout: 10000 }
      );

      if (keygenResult.status === 0 && existsSync(rsaPublicKeyPath)) {
        try {
          chmodSync(rsaPrivateKeyPath, 0o600);
          chmodSync(rsaPublicKeyPath, 0o644);
        } catch {}
        
        const key = readFileSync(rsaPublicKeyPath, "utf-8").trim();
        if (key.length > 0) return key;
      }
    } catch {}
  }

  return null;
}

function readServicePublicKey(): string | null {
  // 1) Explicit override via env (absolute path to a public key file)
  const explicit = process.env.LXC_MANAGER_PUBKEY_FILE;
  if (explicit && existsSync(explicit)) {
    try {
      const key = readFileSync(explicit, "utf-8").trim();
      if (key) return key;
    } catch {}
  }

  // 2) Prefer the current user's home (~/.ssh/*) during setup/development
  const currentHome = process.env.HOME || homedir();
  const homes: string[] = [];
  if (currentHome) homes.push(currentHome);

  // 3) Fallbacks (only if not found in current user's home)
  const envServiceHome = process.env.LXC_MANAGER_USER_HOME;
  if (envServiceHome) homes.push(envServiceHome);
  homes.push("/var/lib/lxc-manager", "/home/lxc-manager", "/home/lxc");

  const filenames = ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"];

  for (const h of homes) {
    for (const f of filenames) {
      const p = path.join(h, ".ssh", f);
      try {
        if (existsSync(p)) {
          const key = readFileSync(p, "utf-8").trim();
          if (key.length > 0) return key;
        }
      } catch {}
    }
  }

  // 4) If no key found, try to generate one automatically for the lxc user
  const generatedKey = generateSshKeyForLxcUser();
  if (generatedKey) return generatedKey;

  return null;
}

function buildAppendCommand(
  pubKey: string,
  targetFile: string = "~/.ssh/authorized_keys",
): string {
  // Use single quotes around key to avoid shell expansion; comments should not contain single quotes
  return `echo '${pubKey}' >>${targetFile}`;
}

export class Ssh {
  /**
   * Check if SSH port is listening on the host
   */
  static checkSshPortListening(
    host: string,
    port?: number,
  ): boolean {
    const sshPort = port || 22;
    try {
      // Try multiple methods to check if port is open
      // Method 1: nc with -z flag (GNU netcat)
      try {
        const res1 = spawnSync(
          "nc",
          ["-z", "-w", "2", host, String(sshPort)],
          { encoding: "utf-8", timeout: 3000 }
        );
        if (res1.status === 0) return true;
      } catch {}

      // Method 2: timeout + nc (if timeout command exists)
      try {
        const res2 = spawnSync(
          "timeout",
          ["2", "nc", "-z", host, String(sshPort)],
          { encoding: "utf-8", timeout: 3000 }
        );
        if (res2.status === 0) return true;
      } catch {}

      // Method 3: Use ssh connection test as fallback (if port is open but auth fails, port is listening)
      // This is less reliable but better than nothing
      const sshTest = this.checkSshPermission(host, port);
      // If we get any response (even permission denied), the port is likely listening
      // We check if stderr contains connection-related errors vs auth errors
      if (sshTest.stderr) {
        const stderr = sshTest.stderr.toLowerCase();
        // Connection refused means port is not listening
        if (stderr.includes("connection refused") || stderr.includes("no route to host")) {
          return false;
        }
        // Other errors (like permission denied) suggest port is listening
        return true;
      }
      
      return false;
    } catch (err: any) {
      // If all checks fail, assume port is not listening to be safe
      return false;
    }
  }

  static checkSshPermission(
    host: string,
    port?: number,
  ): { permissionOk: boolean; stderr?: string } {
    try {
      const sshCmd = "ssh";
      const args = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=2",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
      ];
      if (port && Number.isFinite(port)) {
        args.push("-p", String(port));
      }
      args.push(`root@${host}`, "true");
      const res = spawnSync(sshCmd, args, { encoding: "utf-8", timeout: 3000 });
      const result: { permissionOk: boolean; stderr?: string } = {
        permissionOk: res.status === 0,
      };
      if (typeof res.stderr === "string" && res.stderr.length > 0) {
        result.stderr = res.stderr;
      }
      return result;
    } catch (err: any) {
      const result: { permissionOk: boolean; stderr?: string } = {
        permissionOk: false,
      };
      if (err?.message) result.stderr = String(err.message);
      return result;
    }
  }
  static getPublicKey(): string | null {
    return readServicePublicKey();
  }

  static getPublicKeyCommand(): string | null {
    const key = this.getPublicKey();
    return key ? buildAppendCommand(key) : null;
  }

  static getInstallSshServerCommand(): string {
    // Debian/Proxmox oriented; create drop-in server config file instead of editing sshd_config
    const cmd =
      "sh -lc 'set -e; " +
      // Install server if apt-get exists
      "if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server; fi; " +
      // Prepare dirs and drop-in config
      "mkdir -p /root/.ssh /var/run/sshd /etc/ssh/sshd_config.d; " +
      // Write lxc-manager drop-in configuration
      "cat > /etc/ssh/sshd_config.d/lxc-manager.conf <<'EOF'\n" +
      "PermitRootLogin prohibit-password\n" +
      "PubkeyAuthentication yes\n" +
      "PasswordAuthentication no\n" +
      "ChallengeResponseAuthentication no\n" +
      "UsePAM no\n" +
      "AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys\n" +
      "AllowUsers root\n" +
      "EOF\n" +
      // Enable and restart service (ssh or sshd)
      "(systemctl enable ssh || systemctl enable sshd || true); " +
      "(systemctl restart ssh || systemctl restart sshd || service ssh restart || service sshd restart || true)" +
      "'";
    return cmd;
  }

  /**
   * Build an ISsh descriptor from the current VE context in StorageContext,
   * attaching a publicKeyCommand to be executed on a Proxmox host.
   */
  static fromCurrentContext(storage: StorageContext): ISsh | null {
    const ctx = storage.getCurrentVEContext();
    if (!ctx) return null;
    const pub = this.getPublicKeyCommand();
    const base: ISsh = { host: ctx.host } as ISsh;
    if (typeof ctx.port === "number") base.port = ctx.port;
    if (typeof ctx.current === "boolean") base.current = ctx.current;
    if (pub) base.publicKeyCommand = pub;
    // Only include installSshServer command if SSH port is not listening
    const portListening = this.checkSshPortListening(base.host, base.port);
    if (!portListening) {
      base.installSshServer = this.getInstallSshServerCommand();
    }
    const perm = this.checkSshPermission(base.host, base.port);
    base.permissionOk = perm.permissionOk;
    if (perm.stderr) (base as any).stderr = perm.stderr;
    return base;
  }

  /**
   * Build ISsh descriptors for all VE contexts.
   */
  static allFromStorage(storage: StorageContext): ISsh[] {
    const result: ISsh[] = [];
    const pubCmd = this.getPublicKeyCommand();
    for (const key of storage.keys().filter((k) => k.startsWith("ve_"))) {
      const anyCtx: any = storage.get(key);
      if (anyCtx && typeof anyCtx.host === "string") {
        const item: ISsh = { host: anyCtx.host } as ISsh;
        if (typeof anyCtx.port === "number") item.port = anyCtx.port;
        if (typeof anyCtx.current === "boolean") item.current = anyCtx.current;
        if (pubCmd) item.publicKeyCommand = pubCmd;
        // Only include installSshServer command if SSH port is not listening
        const portListening = this.checkSshPortListening(item.host, item.port);
        if (!portListening) {
          item.installSshServer = this.getInstallSshServerCommand();
        }
        const perm = this.checkSshPermission(item.host, item.port);
        item.permissionOk = perm.permissionOk;
        if (perm.stderr) (item as any).stderr = perm.stderr;
        result.push(item);
      }
    }
    return result;
  }
}
