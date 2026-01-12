# OCI Image Download Analysis

## Problem

Einige Docker Hub OCI-Images (z.B. `phpmyadmin:latest`, `mariadb:10.11`) können nicht mit unserem Python-Script `get-oci-image.py` heruntergeladen werden.

**Fehlermeldung:**
```
HTTP 400 Bad Request
Missing x-amz-content-sha256
```

## Ursache

Docker Hub speichert manche OCI-Images in einem **S3-kompatiblen Storage-Backend**, das AWS S3 Signature V4 erfordert:

1. **Unsere Python-Implementierung** (`urllib.request`) unterstützt keine S3-Signaturen
2. **Betroffene Images**: Images, die in S3-kompatiblem Storage liegen (nicht alle!)
3. **Funktionierende Images**: Images, die in regulärem Storage liegen (z.B. `homeassistant/home-assistant`)

## Wie Proxmox 9.1 es löst

Proxmox 9.1 verwendet **`skopeo`** zum Download von OCI-Images ([Quelle](https://lore.proxmox.com/pve-devel/20251008171028.196998-1-f.schauer%40proxmox.com/)).

### Warum `skopeo` funktioniert:

1. **Go `container/image` Library**: `skopeo` nutzt die Go-Bibliothek `github.com/containers/image`
2. **Automatische S3-Signaturen**: Diese Library implementiert AWS S3 Signature V4 korrekt
3. **Weitverbreitet**: Wird auch von `podman`, `buildah` verwendet

### Proxmox API Endpunkte:

- `GET /nodes/{node}/query-oci-repo-tags` - Listet Tags für ein Repository
- `POST /nodes/{node}/download-oci-image` - Lädt OCI-Image herunter

Diese API-Endpunkte verwenden intern `skopeo` oder die gleichen Go-Libraries.

## Lösungen

### 1. `skopeo` als Fallback verwenden (empfohlen)

Wenn `skopeo` auf dem System verfügbar ist, können wir es als Fallback verwenden:

```bash
skopeo copy docker://phpmyadmin:latest oci-archive:phpmyadmin.tar
```

**Vorteile:**
- Funktioniert für alle Images (inkl. S3-kompatible)
- Standard-Tool für OCI-Registries
- Wird von Proxmox verwendet

**Nachteile:**
- Zusätzliche Abhängigkeit (`skopeo` muss installiert sein)
- Subprocess-Aufruf nötig

### 2. Proxmox API verwenden

Falls ein Proxmox-Host verfügbar ist, können wir die Proxmox API direkt verwenden:

```python
POST /nodes/{node}/download-oci-image
{
  "repo": "docker.io/library/phpmyadmin",
  "tag": "latest",
  "storage": "local"
}
```

**Vorteile:**
- Nutzt Proxmox-eigene Implementierung
- Direkt in Proxmox Storage

**Nachteile:**
- Nur verfügbar, wenn Proxmox-Host erreichbar ist
- API-Authentifizierung nötig

### 3. S3-Signaturen in Python implementieren

Komplex, aber möglich mit:
- `boto3` (AWS SDK)
- `aws-requests-auth` (Python library)
- Manuelle S3 Signature V4 Implementierung

**Nachteile:**
- Sehr komplex
- Zusätzliche Abhängigkeiten
- Wartungsaufwand

### 4. Docker CLI verwenden

```bash
docker pull phpmyadmin:latest
docker save phpmyadmin:latest -o phpmyadmin.tar
```

**Nachteile:**
- Docker muss installiert sein
- Nicht alle Umgebungen haben Docker

## Analyse-Methoden

Um zu analysieren, wie Proxmox OCI-Images herunterlädt:

### Auf Proxmox-Host:

```bash
# Netzwerk-Traffic analysieren
sudo tcpdump -i any -w proxmox-oci.pcap 'host registry-1.docker.io'
# Dann Download in Web-UI starten
sudo tcpdump -r proxmox-oci.pcap -A | grep -A 20 'GET /v2/'

# Prozess-Monitoring
sudo strace -e trace=network -f -o proxmox-oci.strace -p $(pgrep -f 'pveam\|skopeo')
grep 'registry-1.docker.io' proxmox-oci.strace | head -50

# Prüfen, ob skopeo verwendet wird
ps aux | grep skopeo
which skopeo
```

### Test mit skopeo:

```bash
# Test ob skopeo phpmyadmin herunterladen kann
skopeo copy docker://phpmyadmin:latest oci-archive:phpmyadmin.tar

# Falls erfolgreich: skopeo nutzt die richtige Methode
```

## Implementierung

Siehe: `json/shared/scripts/get-oci-image.py` - Implementierung mit `skopeo`-Fallback (TODO)

## Referenzen

- [Proxmox 9.1 OCI Support Announcement](https://proxmox.com/de/ueber-uns/details-unternehmen/pressemitteilungen/proxmox-virtual-environment-9-1)
- [Proxmox OCI API Documentation](https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/query-oci-repo-tags)
- [Skopeo Documentation](https://github.com/containers/skopeo)
- [container/image Library](https://github.com/containers/image)
- [Proxmox Development Mailing List - OCI Implementation](https://lore.proxmox.com/pve-devel/20251008171028.196998-1-f.schauer%40proxmox.com/)


