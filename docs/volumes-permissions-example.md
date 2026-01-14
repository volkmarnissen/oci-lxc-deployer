# Volumes mit Permissions - Beispiele

## Syntax

Der `volumes` Parameter in Template 160 (Bind Multiple Volumes to LXC) unterstützt nun optionale Permissions:

```
<name>=<path>[,<permissions>]
```

- `<name>`: Volume-Name (wird als Subdirectory verwendet)
- `<path>`: Pfad im Container (z.B. `/var/lib/myapp/data`)
- `<permissions>`: Optionale Unix-Permissions (z.B. `0700`, `0755`, `0644`)
  - Default: `0755` (wenn nicht angegeben)

## Beispiele

### 1. Standard-Permissions (755 - Owner: rwx, Group: rx, World: rx)
```
data=/var/lib/myapp/data
logs=/var/lib/myapp/logs
```

### 2. Nur Owner-Zugriff (700 - Owner: rwx, Group: ---, World: ---)
```
secrets=/var/lib/myapp/secrets,0700
private=/var/lib/myapp/private,0700
```

### 3. Gemischte Permissions
```
data=/var/lib/myapp/data,0755
logs=/var/lib/myapp/logs,0755
config=/var/lib/myapp/config,0750
secrets=/var/lib/myapp/secrets,0700
readonly=/var/lib/myapp/readonly,0444
```

### 4. Typische Use-Cases

#### Private Backup-Verzeichnisse
```
timemachine=/mnt/timemachine,0700
backup=/mnt/backup,0700
```

#### Öffentliche Shares mit eingeschränktem Schreibzugriff
```
public=/var/www/public,0755
uploads=/var/www/uploads,0770
```

#### Datenbank-Verzeichnisse
```
mysql_data=/var/lib/mysql,0700
mysql_logs=/var/log/mysql,0750
```

## Kompatibilität

- **Rückwärtskompatibel**: Alte Templates ohne Permissions funktionieren weiterhin (Default: 0755)
- **Samba-Integration**: Template 320 (Install Samba) ignoriert Permissions und extrahiert nur Namen und Pfade

## Technische Details

- Permissions werden mit `chmod -R` rekursiv auf das Host-Verzeichnis angewendet
- Ownership wird über `mapped_uid`/`mapped_gid` oder `uid`/`gid` Parameter gesetzt
- Format: Oktal-Notation (z.B. `0700`, `0755`, `0644`)
- Bei 1:1 UID-Mapping: Container UID N → Host UID N (keine Offset-Berechnung)

## Siehe auch

- [160-bind-multiple-volumes-to-lxc.json](../json/shared/templates/160-bind-multiple-volumes-to-lxc.json)
- [bind-multiple-volumes-to-lxc.sh](../json/shared/scripts/bind-multiple-volumes-to-lxc.sh)
- [320-install-samba.json](../json/shared/templates/320-install-samba.json)
