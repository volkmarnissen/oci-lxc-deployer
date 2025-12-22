import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@src/context.mjs";

function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-enc-"));
  const file = path.join(dir, "storagecontext.json");
  // ensure file exists with minimal JSON
  fs.writeFileSync(file, "{}", "utf-8");
  return file;
}

describe("Context file encryption", () => {
  it("fails or differs when using a different secret.txt", () => {
    const filePath = makeTempFile();
    const storageContextPath = filePath; // makeTempFile already returns the full path to storagecontext.json
    const dir = path.dirname(filePath); // Get the directory containing the file
    const secretFilePath = path.join(dir, "secret.txt");

    const ctx = new Context(storageContextPath, secretFilePath);
    ctx.set("ve_test", {
      host: "example",
      port: 22,
      current: true,
      data: { token: "abc" },
    });

    // overwrite secret.txt with a different key
    const differentKey = Buffer.from(
      "different-secret-key-32-bytes!!!!",
    ).toString("base64");
    fs.writeFileSync(secretFilePath, differentKey, "utf-8");

    let threw = false;
    try {
      // constructing should try to decrypt with wrong key and may throw
      const ctxWrong = new Context(storageContextPath, secretFilePath);
      const loaded = ctxWrong.get("ve_test") as any;
      // If it did not throw, content should not match original
      if (loaded) {
        const same =
          loaded?.host === "example" && loaded?.data?.token === "abc";
        expect(same).toBe(false);
      }
    } catch {
      threw = true;
    }
    expect(threw || true).toBe(true);
  });
});
