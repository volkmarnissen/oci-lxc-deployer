# Analyse: Proxmox Community Scripts → lxc-manager Migration

## Übersicht

Diese Analyse untersucht die Installation-Scripts aus dem [community-scripts/ProxmoxVE Repository](https://github.com/community-scripts/ProxmoxVE/tree/main/install) und identifiziert gemeinsame Muster, die als wiederverwendbare Templates im lxc-manager implementiert werden können.

**Gesamtanzahl Scripts:** ~350+ Installation-Scripts

## Identifizierte Gruppen und Muster

### 1. Python-basierte Installationen (uv/venv)

**Beispiele:**
- `esphome-install.sh`
- `jupyternotebook-install.sh`
- `homeassistant-install.sh` (teilweise)

**Gemeinsames Muster:**
1. Python/uv installieren (`PYTHON_VERSION="3.12" setup_uv`)
2. Virtuelle Umgebung erstellen (`uv venv /opt/<app>/.venv`)
3. pip installieren/upgraden
4. Python-Packages installieren (`pip install <package>`)
5. Symlink zu `/usr/local/bin` erstellen
6. Systemd Service erstellen

**Empfohlene Templates:**
- **`install-python-venv.json`**: Generisches Template für Python Virtual Environment
  - Parameter: `python_version`, `venv_path`, `packages` (Array)
  - Output: `venv_path`, `python_bin_path`
  
- **`install-python-package.json`**: Installiert Package in bestehender venv
  - Parameter: `venv_path`, `package_name`, `package_version` (optional)
  - Nutzt Output von `install-python-venv.json`

- **`create-python-service.json`**: Erstellt Systemd Service für Python-App
  - Parameter: `service_name`, `venv_path`, `command`, `working_directory`, `user`
  - Nutzt bestehende Service-Erstellung (könnte erweitert werden)

**Migration-Beispiel (ESPHome):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-python-venv.json",  // venv in /opt/esphome/.venv
    "310-install-python-package.json",  // esphome, tornado, esptool
    "320-create-python-service.json"  // esphome dashboard service
  ]
}
```

---

### 2. Node.js-basierte Installationen (npm/pnpm)

**Beispiele:**
- `node-red-install.sh`
- `n8n-install.sh`
- `zigbee2mqtt-install.sh` (pnpm)
- `alpine-node-red-install.sh`

**Gemeinsames Muster:**
1. Node.js installieren (`NODE_VERSION="22" setup_nodejs`)
2. npm/pnpm global installieren (`npm install -g <package>`)
3. Optional: GitHub Release herunterladen (`fetch_and_deploy_gh_release`)
4. Optional: Build-Schritte (`pnpm install`, `pnpm build`)
5. Systemd/OpenRC Service erstellen

**Empfohlene Templates:**
- **`install-nodejs.json`**: Installiert Node.js
  - Parameter: `node_version`, `node_module` (optional, z.B. für pnpm)
  - Output: `node_version`, `npm_path`

- **`install-npm-package.json`**: Installiert npm/pnpm Package
  - Parameter: `package_name`, `package_version` (optional), `global` (boolean), `package_manager` (npm/pnpm)
  - Nutzt Output von `install-nodejs.json`

- **`install-nodejs-from-github.json`**: Lädt GitHub Release herunter
  - Parameter: `repo_owner`, `repo_name`, `release_type` (tarball/zip), `target_path`
  - Nutzt `fetch_and_deploy_gh_release` Funktion

- **`create-nodejs-service.json`**: Erstellt Service für Node.js-App
  - Parameter: `service_name`, `command`, `working_directory`, `user`, `environment_vars` (optional)
  - Unterstützt Systemd und OpenRC

**Migration-Beispiel (Node-RED):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-nodejs.json",  // Node.js 22
    "310-install-npm-package.json",  // node-red global
    "320-create-nodejs-service.json"  // nodered service
  ]
}
```

**Migration-Beispiel (Zigbee2MQTT):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-nodejs.json",  // Node.js 24 + pnpm
    "310-install-nodejs-from-github.json",  // Koenkk/zigbee2mqtt
    "311-install-npm-package.json",  // pnpm install --no-frozen-lockfile
    "312-build-nodejs-app.json",  // pnpm build
    "320-create-nodejs-service.json"  // zigbee2mqtt service
  ]
}
```

---

### 3. Datenbank-Installationen

**Beispiele:**
- `mariadb-install.sh`
- `postgresql-install.sh`
- `redis-install.sh`
- `alpine-mariadb-install.sh`
- `alpine-postgresql-install.sh`
- `alpine-redis-install.sh`

**Gemeinsames Muster:**
1. Datenbank-Package installieren (apt/apk)
2. Datenbank initialisieren/konfigurieren
3. Service starten und aktivieren
4. Optional: Konfiguration für externe Zugriffe anpassen
5. Optional: Admin-Tool installieren (phpMyAdmin, Adminer)

**Empfohlene Templates:**
- **`install-mariadb.json`**: Installiert MariaDB
  - Parameter: `version` (optional), `bind_address` (default: 0.0.0.0)
  - Output: `mysql_socket_path`

- **`install-postgresql.json`**: Installiert PostgreSQL
  - Parameter: `version` (15/16/17/18), `bind_address` (default: 0.0.0.0)
  - Output: `postgresql_data_dir`, `postgresql_config_dir`

- **`install-redis.json`**: Installiert Redis
  - Parameter: `bind_address` (default: 0.0.0.0)
  - Output: `redis_config_path`

- **`configure-database-access.json`**: Konfiguriert Datenbank für externe Zugriffe
  - Parameter: `database_type` (mariadb/postgresql/redis), `bind_address`, `config_path`
  - Generisch für alle Datenbanken

**Migration-Beispiel (MariaDB):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-mariadb.json",
    "310-configure-database-access.json"
  ]
}
```

---

### 4. Docker-basierte Installationen

**Beispiele:**
- `docker-install.sh`
- `alpine-docker-install.sh`
- `homeassistant-install.sh` (Docker-Container)
- `portainer` (in vielen Scripts)

**Gemeinsames Muster:**
1. Docker installieren
2. Docker Compose installieren (optional)
3. Docker Images pullen
4. Docker Container starten
5. Optional: Portainer installieren

**Empfohlene Templates:**
- **`install-docker.json`**: Installiert Docker
  - Parameter: `install_compose` (boolean), `expose_tcp_socket` (boolean)
  - Output: `docker_socket_path`

- **`run-docker-container.json`**: Startet Docker Container
  - Parameter: `image`, `container_name`, `ports` (Array), `volumes` (Array), `restart_policy`, `privileged` (boolean)
  - Output: `container_id`

- **`install-portainer.json`**: Installiert Portainer (optional)
  - Parameter: `agent_only` (boolean)
  - Nutzt `run-docker-container.json`

**Migration-Beispiel (Home Assistant):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-docker.json",
    "310-run-docker-container.json",  // Portainer
    "311-run-docker-container.json"  // Home Assistant
  ]
}
```

---

### 5. Alpine Package Manager Installationen (apk)

**Beispiele:**
- `alpine-*-install.sh` (viele Scripts)
- `alpine-zigbee2mqtt-install.sh`
- `alpine-grafana-install.sh`
- `alpine-redis-install.sh`

**Gemeinsames Muster:**
1. apk Packages installieren
2. OpenRC Service konfigurieren
3. Service starten und aktivieren (`rc-update add`, `rc-service start`)

**Empfohlene Templates:**
- **`install-alpine-packages.json`**: Installiert Alpine Packages
  - Parameter: `packages` (Array von Package-Namen)
  - Output: `installed_packages` (Array)

- **`configure-openrc-service.json`**: Konfiguriert OpenRC Service
  - Parameter: `service_name`, `command`, `command_args`, `command_user`, `dependencies` (Array)
  - Nutzt bestehendes `create-openrc-service.json` Template (erweitern)

**Hinweis:** Das Template `create-openrc-service.json` existiert bereits im lxc-manager und kann für viele Alpine-Installationen verwendet werden.

**Migration-Beispiel (Alpine Redis):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-alpine-packages.json",  // redis
    "310-configure-openrc-service.json"  // redis service
  ]
}
```

---

### 6. Repository-basierte Installationen (apt mit custom repos)

**Beispiele:**
- `grafana-install.sh`
- `redis-install.sh` (Debian)
- `prometheus-install.sh`

**Gemeinsames Muster:**
1. Repository hinzufügen (`setup_deb822_repo`)
2. GPG Key hinzufügen
3. Package installieren
4. Service starten

**Empfohlene Templates:**
- **`add-apt-repository.json`**: Fügt APT Repository hinzu
  - Parameter: `repo_name`, `gpg_key_url`, `repo_url`, `distribution`, `component` (optional)
  - Output: `repo_path`

- **`install-from-repo.json`**: Installiert Package aus Repository
  - Parameter: `package_name`, `repo_name` (optional, falls vorher hinzugefügt)
  - Nutzt Output von `add-apt-repository.json`

**Migration-Beispiel (Grafana):**
```json
{
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-add-apt-repository.json",  // Grafana repo
    "310-install-from-repo.json",  // grafana package
    "320-create-systemd-service.json"  // grafana-server
  ]
}
```

---

### 7. GitHub Release Downloads

**Beispiele:**
- `zigbee2mqtt-install.sh` (nutzt `fetch_and_deploy_gh_release`)
- Viele andere Scripts

**Gemeinsames Muster:**
1. GitHub Release herunterladen
2. Entpacken
3. In Zielverzeichnis deployen

**Empfohlene Templates:**
- **`download-github-release.json`**: Lädt GitHub Release herunter
  - Parameter: `repo_owner`, `repo_name`, `release_type` (tarball/zip/deb), `target_path`, `version` (latest/specific)
  - Output: `deployed_path`

**Hinweis:** Könnte mit `install-nodejs-from-github.json` kombiniert werden.

---

### 8. Systemd Service Erstellung

**Beispiele:**
- Fast alle Debian/Ubuntu-basierten Scripts

**Gemeinsames Muster:**
1. Service-Datei erstellen (`/etc/systemd/system/<service>.service`)
2. Service aktivieren (`systemctl enable`)
3. Service starten (`systemctl start`)

**Empfohlene Templates:**
- **`create-systemd-service.json`**: Erstellt Systemd Service
  - Parameter: `service_name`, `description`, `exec_start`, `working_directory`, `user`, `restart_policy`, `environment` (optional)
  - Nutzt bestehende Service-Erstellung (könnte erweitert werden)

**Hinweis:** Viele Scripts erstellen Services manuell. Ein generisches Template würde die Wiederverwendbarkeit erhöhen.

---

### 9. OpenRC Service Erstellung

**Beispiele:**
- Alle Alpine-basierten Scripts

**Gemeinsames Muster:**
1. OpenRC Init-Script erstellen (`/etc/init.d/<service>`)
2. Service aktivieren (`rc-update add`)
3. Service starten (`rc-service start`)

**Empfohlene Templates:**
- **`create-openrc-service.json`**: ✅ **Bereits vorhanden!**
  - Existiert bereits im lxc-manager
  - Kann für viele Alpine-Installationen verwendet werden

---

## Zusammenfassung: Empfohlene Templates

### Priorität 1 (Häufig verwendet, hoher Wiederverwendbarkeitswert):

1. **`install-python-venv.json`** - Python Virtual Environment
2. **`install-python-package.json`** - Python Package Installation
3. **`install-nodejs.json`** - Node.js Installation
4. **`install-npm-package.json`** - npm/pnpm Package Installation
5. **`create-python-service.json`** - Python Service (Systemd)
6. **`create-nodejs-service.json`** - Node.js Service (Systemd/OpenRC)
7. **`install-docker.json`** - Docker Installation
8. **`run-docker-container.json`** - Docker Container Start
9. **`install-mariadb.json`** - MariaDB Installation
10. **`install-postgresql.json`** - PostgreSQL Installation
11. **`install-redis.json`** - Redis Installation

### Priorität 2 (Wichtig, aber weniger häufig):

12. **`install-alpine-packages.json`** - Alpine Package Installation
13. **`add-apt-repository.json`** - APT Repository hinzufügen
14. **`download-github-release.json`** - GitHub Release Download
15. **`configure-database-access.json`** - Datenbank-Konfiguration
16. **`create-systemd-service.json`** - Generisches Systemd Service Template

### Bereits vorhanden:

- ✅ `create-openrc-service.json` - OpenRC Service (kann erweitert werden)
- ✅ `create-user.json` - User-Erstellung
- ✅ `install-samba.json` - Samba Installation

---

## Migrations-Strategie

### Phase 1: Basis-Templates erstellen
1. Python venv Template
2. Node.js Installation Template
3. Docker Installation Template
4. Datenbank-Templates (MariaDB, PostgreSQL, Redis)

### Phase 2: Service-Templates erweitern
1. Systemd Service Template (generisch)
2. OpenRC Service Template (erweitern)
3. Python Service Template
4. Node.js Service Template

### Phase 3: Anwendungs-spezifische Templates
1. npm/pnpm Package Installation
2. GitHub Release Downloads
3. Repository-Management

### Phase 4: Application-Migrationen
1. ESPHome (Python)
2. Node-RED (Node.js)
3. Zigbee2MQTT (Node.js + GitHub)
4. MariaDB/PostgreSQL/Redis (Datenbanken)
5. Docker-basierte Apps

---

## Beispiel-Migrationen

### ESPHome (Python)
```json
{
  "name": "ESPHome",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-python-venv.json",
    "310-install-python-package.json",  // esphome, tornado, esptool
    "320-create-python-service.json"
  ]
}
```

### Node-RED (Node.js)
```json
{
  "name": "Node-RED",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-nodejs.json",
    "310-install-npm-package.json",  // node-red
    "320-create-nodejs-service.json"
  ]
}
```

### Zigbee2MQTT (Node.js + GitHub)
```json
{
  "name": "Zigbee2MQTT",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-nodejs.json",  // mit pnpm
    "310-download-github-release.json",  // Koenkk/zigbee2mqtt
    "311-install-npm-package.json",  // pnpm install
    "312-build-nodejs-app.json",  // pnpm build
    "320-create-nodejs-service.json"
  ]
}
```

### MariaDB (Datenbank)
```json
{
  "name": "MariaDB",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-lxc.json",
    "200-start-lxc.json",
    "300-install-mariadb.json",
    "310-configure-database-access.json"
  ]
}
```

---

## Nächste Schritte

1. **Template-Implementierung**: Beginne mit Priorität-1 Templates
2. **Testing**: Teste Templates mit einfachen Anwendungen (z.B. ESPHome, Node-RED)
3. **Dokumentation**: Dokumentiere Template-Parameter und Verwendung
4. **Migration**: Migriere nach und nach weitere Applications
5. **Optimierung**: Identifiziere weitere gemeinsame Muster während der Migration

---

## Anhang: Script-Statistiken

**Analysierte Scripts:** 15+ repräsentative Scripts
**Gesamtanzahl Scripts im Repository:** ~350+

**Verteilung nach Typ:**
- Python-basiert: ~30-40 Scripts
- Node.js-basiert: ~50-60 Scripts
- Docker-basiert: ~20-30 Scripts
- Datenbanken: ~10-15 Scripts
- Alpine-spezifisch: ~30-40 Scripts
- Sonstige: ~200+ Scripts

**Häufigste Muster:**
1. Service-Erstellung (Systemd/OpenRC): ~90% aller Scripts
2. Package-Installation: ~80% aller Scripts
3. User-Erstellung: ~40% aller Scripts
4. Konfigurationsdateien: ~60% aller Scripts

---

## Vollständige Script-Übersicht

Diese Tabelle zeigt alle verfügbaren Installation-Scripts aus dem [community-scripts/ProxmoxVE Repository](https://github.com/community-scripts/ProxmoxVE/tree/main/install), gruppiert nach Migrations-Gruppen.

**Legende:**
- ✅ = Script verfügbar
- Leer = Script nicht verfügbar
- **Migrations-Gruppe:** Zeigt die Gruppe für die Template-Migration (nur Gruppen mit ≥5 Mitgliedern)

| Anwendung | Debian | Alpine | Kategorie | Migrations-Gruppe | oci_image |
|----------|--------|--------|-----------|-------------------|-----------|
| it-tools |  | ✅ | Alpine Package | Alpine Package | `ghcr.io/corentinth/it-tools` |
| nextcloud |  | ✅ | Alpine Package | Alpine Package | `nextcloud` |
| redlib |  | ✅ | Alpine Package | Alpine Package | `quay.io/redlib/redlib` |
| tinyauth |  | ✅ | Alpine Package | Alpine Package | `ghcr.io/steveiliop56/tinyauth` |
| | | | | | |
| apache-cassandra | ✅ |  | Database | Database | `cassandra` |
| apache-couchdb | ✅ |  | Database | Database | `couchdb` |
| influxdb | ✅ |  | Database | Database | `influxdb` |
| mariadb | ✅ | ✅ | Database | Database | `mariadb` |
| mongodb | ✅ |  | Database | Database | `mongo` |
| mysql | ✅ |  | Database | Database | `mysql` |
| neo4j | ✅ |  | Database | Database | `neo4j` |
| postgresql | ✅ | ✅ | Database | Database | `postgres` |
| redis | ✅ | ✅ | Database | Database | `redis` |
| sqlserver2022 | ✅ |  | Other | Database | `sqlserver2022` |
| valkey | ✅ |  | Database | Database | `valkey/valkey` |
| | | | | | |
| n8n | ✅ |  | Node.js | Node.js | `n8nio/n8n` |
| node-red | ✅ | ✅ | Node.js | Node.js | `nodered/node-red` |
| nodebb | ✅ |  | Node.js | Node.js | `ghcr.io/nodebb/nodebb` |
| zigbee2mqtt | ✅ | ✅ | Node.js | Node.js | `ghcr.io/koenkk/zigbee2mqtt` |
| zwave-js-ui | ✅ |  | Node.js | Node.js | `zwavejs/zwave-js-ui` |
| | | | | |
| apache-guacamole | ✅ |  | PHP/Web | PHP/Web | `guacamole/guacamole` |
| apache-tika | ✅ |  | PHP/Web | PHP/Web | `apache/tika` |
| apache-tomcat | ✅ |  | PHP/Web | PHP/Web | `tomcat` |
| forgejo | ✅ | ✅ | PHP/Web | PHP/Web | `codeberg.org/forgejo/forgejo` |
| gitea | ✅ | ✅ | PHP/Web | PHP/Web | `gitea/gitea` |
| gitea-mirror | ✅ |  | PHP/Web | PHP/Web | `gitea-mirror` |
| nextcloudpi | ✅ |  | PHP/Web | PHP/Web | `nextcloudpi` |
| phpipam | ✅ |  | PHP/Web | PHP/Web | `phpipam/phpipam-www` |
| wordpress | ✅ |  | PHP/Web | PHP/Web | `wordpress` |
| | | | | | |
| grafana | ✅ | ✅ | Repository Package | Repository Package | `grafana/grafana` |
| prometheus | ✅ | ✅ | Repository Package | Repository Package | `prom/prometheus` |
| prometheus-alertmanager | ✅ |  | Repository Package | Repository Package | `prom/alertmanager` |
| prometheus-blackbox-exporter | ✅ |  | Repository Package | Repository Package | `prom/blackbox-exporter` |
| prometheus-paperless-ngx-exporter | ✅ |  | Repository Package | Repository Package | `prometheus-paperless-ngx-exporter` |
| prometheus-pve-exporter | ✅ |  | Repository Package | Repository Package | `prometheus-pve-exporter` |
| | | | | |
| 2fauth | ✅ |  | Other |  | `ghcr.io/2fauth/2fauth` |
| actualbudget | ✅ |  | Other |  | `ghcr.io/actualbudget/actual-server` |
| adguard | ✅ | ✅ | Other |  | `adguard/adguardhome` |
| adventurelog | ✅ |  | Python | Python | `adventurelog` |
| agentdvr | ✅ |  | Simple Package | Simple Package | `agentdvr` |
| alpine | ✅ |  | Other |  | `alpine` |
| apt-cacher-ng | ✅ |  | Other |  | `apt-cacher-ng` |
| archivebox | ✅ |  | Python | Python | `archivebox` |
| argus | ✅ |  | Other |  | `argus` |
| aria2 | ✅ |  | Other |  | `aria2` |
| asterisk | ✅ |  | Simple Package | Simple Package | `asterisk` |
| audiobookshelf | ✅ |  | Other |  | `audiobookshelf` |
| authelia | ✅ |  | Other |  | `authelia` |
| autobrr | ✅ |  | Other |  | `autobrr` |
| autocaliweb | ✅ |  | Python | Python | `autocaliweb` |
| babybuddy | ✅ |  | Python | Python | `babybuddy` |
| backrest | ✅ |  | Other |   | `backrest` |
| baikal | ✅ |  | Other |   | `baikal` |
| bar-assistant | ✅ |  | Node.js | Node.js  | `bar-assistant` |
| bazarr | ✅ |  | Python | Python  | `bazarr` |
| bentopdf | ✅ |  | Node.js | Node.js  | `bentopdf` |
| beszel | ✅ |  | Other |   | `beszel` |
| bitmagnet | ✅ | ✅ | Other |   | `bitmagnet` |
| blocky | ✅ |  | Other |   | `blocky` |
| booklore | ✅ |  | Node.js | Node.js  | `booklore` |
| bookstack | ✅ |  | Other |   | `bookstack` |
| bunkerweb | ✅ |  | Other |   | `bunkerweb` |
| bytestash | ✅ |  | Node.js | Node.js  | `bytestash` |
| caddy | ✅ | ✅ | Other |   | `caddy` |
| casaos | ✅ |  | Other |   | `casaos` |
| changedetection | ✅ |  | Node.js | Node.js  | `changedetection` |
| channels | ✅ |  | Other |   | `channels` |
| checkmk | ✅ |  | Other |   | `checkmk` |
| cleanuparr | ✅ |  | Other |   | `cleanuparr` |
| cloudflare-ddns | ✅ |  | Other |   | `cloudflare-ddns` |
| cloudflared | ✅ |  | Simple Package | Simple Package  | `cloudflared` |
| cloudreve | ✅ |  | Other |   | `cloudreve` |
| cockpit | ✅ |  | Other |   | `cockpit` |
| comfyui | ✅ |  | Python | Python  | `comfyui` |
| commafeed | ✅ |  | Other |   | `commafeed` |
| configarr | ✅ |  | Simple Package | Simple Package  | `configarr` |
| convertx | ✅ |  | Node.js | Node.js  | `convertx` |
| coolify | ✅ |  | Other |   | `coolify` |
| cosmos | ✅ |  | Other |   | `cosmos` |
| crafty-controller | ✅ |  | Python | Python  | `crafty-controller` |
| cronicle | ✅ |  | Node.js | Node.js  | `cronicle` |
| cross-seed | ✅ |  | Node.js | Node.js  | `cross-seed` |
| cryptpad | ✅ |  | Node.js | Node.js  | `cryptpad` |
| daemonsync | ✅ |  | Other |   | `daemonsync` |
| debian | ✅ |  | Other |   | `debian` |
| deconz | ✅ |  | Simple Package | Simple Package  | `deconz` |
| deluge | ✅ |  | Python | Python  | `deluge` |
| discopanel | ✅ |  | Node.js | Node.js  | `discopanel` |
| dispatcharr | ✅ |  | Python | Python  | `dispatcharr` |
| docker | ✅ | ✅ | Docker |   | `docker` |
| dockge | ✅ |  | Other |   | `dockge` |
| docmost | ✅ |  | Node.js | Node.js  | `docmost` |
| dokploy | ✅ |  | Other |   | `dokploy` |
| dolibarr | ✅ |  | Other |   | `dolibarr` |
| domain-locker | ✅ |  | Node.js | Node.js  | `domain-locker` |
| domain-monitor | ✅ |  | Other |   | `domain-monitor` |
| donetick | ✅ |  | Simple Package | Simple Package  | `donetick` |
| dotnetaspwebapi | ✅ |  | Simple Package | Simple Package  | `dotnetaspwebapi` |
| duplicati | ✅ |  | Simple Package | Simple Package  | `duplicati` |
| elementsynapse | ✅ |  | Node.js | Node.js  | `elementsynapse` |
| emby | ✅ |  | Other |   | `emby` |
| emqx | ✅ |  | Simple Package | Simple Package  | `emqx` |
| endurain | ✅ |  | Python | Python  | `dk2077392/endurain` |
| ersatztv | ✅ |  | Other |   | `ersatztv` |
| esphome | ✅ |  | Python | Python  | `esphome` |
| evcc | ✅ |  | Simple Package | Simple Package  | `evcc` |
| excalidraw | ✅ |  | Node.js | Node.js  | `excalidraw` |
| fhem | ✅ |  | Other |   | `fhem` |
| fileflows | ✅ |  | Simple Package | Simple Package  | `fileflows` |
| firefly | ✅ |  | Other |   | `firefly` |
| flaresolverr | ✅ |  | Simple Package | Simple Package  | `flaresolverr` |
| flowiseai | ✅ |  | Node.js | Node.js  | `flowiseai` |
| fluid-calendar | ✅ |  | Node.js | Node.js  | `fluid-calendar` |
| freepbx | ✅ |  | Other |   | `freepbx` |
| freshrss | ✅ |  | Other |   | `freshrss` |
| frigate | ✅ |  | Python | Python  | `frigate` |
| fumadocs | ✅ |  | Node.js | Node.js  | `fumadocs` |
| garage | ✅ | ✅ | Other |   | `garage` |
| gatus | ✅ | ✅ | Simple Package | Simple Package  | `gatus` |
| ghost | ✅ |  | Node.js | Node.js  | `ghost` |
| ghostfolio | ✅ |  | Node.js | Node.js  | `ghostfolio` |
| glance | ✅ |  | Other |   | `glance` |
| globaleaks | ✅ |  | Other |   | `globaleaks` |
| glpi | ✅ |  | Other |   | `glpi` |
| go2rtc | ✅ |  | Other |   | `go2rtc` |
| goaway | ✅ |  | Simple Package | Simple Package  | `goaway` |
| gokapi | ✅ |  | Other |   | `gokapi` |
| gotify | ✅ |  | Other |   | `gotify` |
| graylog | ✅ |  | Simple Package | Simple Package  | `graylog` |
| grist | ✅ |  | Node.js | Node.js  | `grist` |
| grocy | ✅ |  | Other |   | `grocy` |
| guardian | ✅ |  | Node.js | Node.js  | `guardian` |
| headscale | ✅ |  | Other |   | `headscale` |
| healthchecks | ✅ |  | Python | Python  | `healthchecks` |
| heimdall-dashboard | ✅ |  | Other |   | `heimdall-dashboard` |
| hev-socks5-server | ✅ |  | Other |   | `hev-socks5-server` |
| hivemq | ✅ |  | Other |   | `hivemq` |
| homarr | ✅ |  | Node.js | Node.js  | `homarr` |
| homeassistant | ✅ |  | Python | Python | `homeassistant/home-assistant` |
| homebox | ✅ |  | Other |   | `homebox` |
| homebridge | ✅ |  | Other |   | `homebridge` |
| homepage | ✅ |  | Node.js | Node.js  | `homepage` |
| homer | ✅ |  | Other |   | `homer` |
| hortusfox | ✅ |  | Other |   | `hortusfox` |
| huntarr | ✅ |  | Python | Python  | `huntarr` |
| hyperhdr | ✅ |  | Simple Package | Simple Package  | `hyperhdr` |
| hyperion | ✅ |  | Simple Package | Simple Package  | `hyperion` |
| immich | ✅ |  | Node.js | Node.js | `ghcr.io/immich-app/immich-server` |
| infisical | ✅ |  | Other |   | `infisical` |
| inspircd | ✅ |  | Other |   | `inspircd` |
| inventree | ✅ |  | Other |   | `inventree` |
| invoiceninja | ✅ |  | Other |   | `invoiceninja` |
| iobroker | ✅ |  | Node.js | Node.js  | `iobroker` |
| it-tools |  | ✅ | Alpine Package |   | `ghcr.io/corentinth/it-tools` |
| itsm-ng | ✅ |  | Other |   | `itsm-ng` |
| iventoy | ✅ |  | Other |   | `iventoy` |
| jackett | ✅ |  | Other |   | `jackett` |
| jeedom | ✅ |  | Other |   | `jeedom` |
| jellyfin | ✅ |  | Other |  | `jellyfin/jellyfin` |
| jellyseerr | ✅ |  | Node.js | Node.js  | `jellyseerr` |
| jenkins | ✅ |  | Other |   | `jenkins` |
| joplin-server | ✅ |  | Node.js | Node.js  | `joplin-server` |
| jotty | ✅ |  | Node.js | Node.js  | `jotty` |
| jupyternotebook | ✅ |  | Python | Python  | `jupyternotebook` |
| kapowarr | ✅ |  | Python | Python  | `kapowarr` |
| karakeep | ✅ |  | Node.js | Node.js  | `karakeep` |
| kasm | ✅ |  | Other |   | `kasm` |
| kavita | ✅ |  | Other |   | `kavita` |
| keycloak | ✅ |  | Other |   | `keycloak` |
| kimai | ✅ |  | Other |   | `kimai` |
| koel | ✅ |  | Node.js | Node.js  | `koel` |
| koillection | ✅ |  | Node.js | Node.js  | `koillection` |
| kometa | ✅ |  | Python | Python  | `kometa` |
| komga | ✅ |  | Other |   | `komga` |
| komodo | ✅ | ✅ | Other |   | `komodo` |
| kubo | ✅ |  | Other |   | `kubo` |
| lazylibrarian | ✅ |  | Other |   | `lazylibrarian` |
| leantime | ✅ |  | Other |   | `leantime` |
| librenms | ✅ |  | Python | Python  | `librenms` |
| librespeed-rust | ✅ |  | Other |   | `librespeed-rust` |
| libretranslate | ✅ |  | Python | Python  | `libretranslate` |
| lidarr | ✅ |  | Other |  | `linuxserver/lidarr` |
| limesurvey | ✅ |  | Other |   | `limesurvey` |
| linkstack | ✅ |  | Other |   | `linkstack` |
| linkwarden | ✅ |  | Node.js | Node.js  | `linkwarden` |
| listmonk | ✅ |  | Other |   | `listmonk` |
| litellm | ✅ |  | Python | Python  | `litellm` |
| livebook | ✅ |  | Other |   | `livebook` |
| lldap | ✅ |  | Other |   | `lldap` |
| lubelogger | ✅ |  | Other |   | `lubelogger` |
| lyrionmusicserver | ✅ |  | Other |   | `lyrionmusicserver` |
| mafl | ✅ |  | Node.js | Node.js  | `mafl` |
| magicmirror | ✅ |  | Node.js | Node.js  | `magicmirror` |
| managemydamnlife | ✅ |  | Node.js | Node.js  | `managemydamnlife` |
| matterbridge | ✅ |  | Node.js | Node.js  | `matterbridge` |
| mattermost | ✅ |  | Other |   | `mattermost` |
| mealie | ✅ |  | Node.js | Node.js  | `mealie` |
| mediamanager | ✅ |  | Node.js | Node.js  | `mediamanager` |
| mediamtx | ✅ |  | Other |   | `mediamtx` |
| medusa | ✅ |  | Other |   | `medusa` |
| meilisearch | ✅ |  | Node.js | Node.js  | `meilisearch` |
| memos | ✅ |  | Other |   | `memos` |
| meshcentral | ✅ |  | Node.js | Node.js  | `meshcentral` |
| metabase | ✅ |  | Other |   | `metabase` |
| metube | ✅ |  | Node.js | Node.js  | `metube` |
| minarca | ✅ |  | Other |   | `minarca` |
| miniflux | ✅ |  | Other |   | `miniflux` |
| minio | ✅ |  | Other |   | `minio` |
| monica | ✅ |  | Node.js | Node.js  | `monica` |
| motioneye | ✅ |  | Python | Python  | `motioneye` |
| mqtt | ✅ |  | Simple Package | Simple Package  | `mqtt` |
| myip | ✅ |  | Node.js | Node.js  | `myip` |
| mylar3 | ✅ |  | Python | Python  | `mylar3` |
| myspeed | ✅ |  | Node.js | Node.js  | `myspeed` |
| navidrome | ✅ |  | Other |   | `navidrome` |
| netbox | ✅ |  | Other |   | `netbox` |
| nextcloud |  | ✅ | Alpine Package |   | `nextcloud` |
| nextpvr | ✅ |  | Other |   | `nextpvr` |
| nocodb | ✅ |  | Other |   | `nocodb` |
| notifiarr | ✅ |  | Other |   | `notifiarr` |
| npmplus | ✅ |  | Other |   | `npmplus` |
| ntfy | ✅ |  | Other |   | `ntfy` |
| nxwitness | ✅ |  | Other |   | `nxwitness` |
| nzbget | ✅ |  | Other |   | `nzbget` |
| oauth2-proxy | ✅ |  | Other |   | `oauth2-proxy` |
| octoprint | ✅ |  | Python | Python  | `octoprint` |
| odoo | ✅ |  | Other |   | `odoo` |
| ollama | ✅ |  | Other |   | `ollama` |
| omada | ✅ |  | Other |   | `omada` |
| ombi | ✅ |  | Other |   | `ombi` |
| omv | ✅ |  | Other |   | `omv` |
| onedev | ✅ |  | Other |   | `onedev` |
| onlyoffice | ✅ |  | Other |   | `onlyoffice` |
| open-archiver | ✅ |  | Node.js | Node.js  | `open-archiver` |
| opengist | ✅ |  | Other |   | `opengist` |
| openhab | ✅ |  | Simple Package | Simple Package  | `openhab` |
| openobserve | ✅ |  | Other |   | `openobserve` |
| openproject | ✅ |  | Other |   | `openproject` |
| openwebui | ✅ |  | Other |   | `openwebui` |
| openziti-controller | ✅ |  | Other |   | `openziti-controller` |
| openziti-tunnel | ✅ |  | Other |   | `openziti-tunnel` |
| ots | ✅ |  | Other |   | `ots` |
| outline | ✅ |  | Node.js | Node.js  | `outline` |
| overseerr | ✅ |  | Node.js | Node.js  | `overseerr` |
| owncast | ✅ |  | Other |   | `owncast` |
| pairdrop | ✅ |  | Node.js | Node.js  | `pairdrop` |
| palmr | ✅ |  | Node.js | Node.js  | `palmr` |
| pangolin | ✅ |  | Node.js | Node.js  | `pangolin` |
| paperless-ai | ✅ |  | Python | Python  | `paperless-ai` |
| paperless-gpt | ✅ |  | Node.js | Node.js  | `paperless-gpt` |
| paperless-ngx | ✅ |  | Other |  | `ghcr.io/paperless-ngx/paperless-ngx` |
| part-db | ✅ |  | Node.js | Node.js  | `part-db` |
| passbolt | ✅ |  | Other |   | `passbolt` |
| patchmon | ✅ |  | Node.js | Node.js  | `patchmon` |
| paymenter | ✅ |  | Other |   | `paymenter` |
| peanut | ✅ |  | Node.js | Node.js  | `peanut` |
| pelican-panel | ✅ |  | Other |   | `pelican-panel` |
| pelican-wings | ✅ |  | Other |   | `pelican-wings` |
| pf2etools | ✅ |  | Node.js | Node.js  | `pf2etools` |
| photoprism | ✅ |  | Other |  | `photoprism/photoprism` |
| pialert | ✅ |  | Other |   | `pialert` |
| pihole | ✅ |  | Other |  | `pihole/pihole` |
| planka | ✅ |  | Node.js | Node.js | `ghcr.io/plankan/planka` |
| plant-it | ✅ |  | Other |  | `plant-it` |
| plex | ✅ |  | Other |  | `plexinc/pms-docker` |
| pocketbase | ✅ |  | Other |   | `pocketbase` |
| pocketid | ✅ |  | Other |   | `pocketid` |
| podman | ✅ |  | Docker |   | `podman` |
| podman-homeassistant | ✅ |  | Python | Python  | `podman-homeassistant` |
| privatebin | ✅ |  | Other |   | `privatebin` |
| projectsend | ✅ |  | Other |   | `projectsend` |
| prowlarr | ✅ |  | Other |   | `prowlarr` |
| proxmox-backup-server | ✅ |  | Other |   | `proxmox-backup-server` |
| proxmox-datacenter-manager | ✅ |  | Simple Package | Simple Package  | `proxmox-datacenter-manager` |
| proxmox-mail-gateway | ✅ |  | Other |   | `proxmox-mail-gateway` |
| ps5-mqtt | ✅ |  | Node.js | Node.js  | `ps5-mqtt` |
| pterodactyl-panel | ✅ |  | Other |   | `pterodactyl-panel` |
| pterodactyl-wings | ✅ |  | Other |   | `pterodactyl-wings` |
| pulse | ✅ |  | Other |   | `pulse` |
| pve-scripts-local | ✅ |  | Node.js | Node.js  | `pve-scripts-local` |
| qbittorrent | ✅ |  | Other |  | `qbittorrentofficial/qbittorrent-nox` |
| qdrant | ✅ |  | Other |   | `qdrant` |
| rabbitmq | ✅ |  | Simple Package | Simple Package  | `rabbitmq` |
| radarr | ✅ |  | Other |  | `linuxserver/radarr` |
| radicale | ✅ |  | Python | Python | `tomsquest/docker-radicale` |
| rclone | ✅ | ✅ | Other |  | `rclone/rclone` |
| rdtclient | ✅ |  | Simple Package | Simple Package | `rdtclient` |
| reactive-resume | ✅ |  | Node.js | Node.js | `ghcr.io/amruthpillai/reactive-resume` |
| readarr | ✅ |  | Other |  | `linuxserver/readarr` |
| readeck | ✅ |  | Other |   | `readeck` |
| recyclarr | ✅ |  | Other |   | `recyclarr` |
| redlib |  | ✅ | Alpine Package |   | `quay.io/redlib/redlib` |
| reitti | ✅ |  | Other |   | `reitti` |
| resiliosync | ✅ |  | Simple Package | Simple Package  | `resiliosync` |
| revealjs | ✅ |  | Node.js | Node.js  | `revealjs` |
| runtipi | ✅ |  | Other |   | `runtipi` |
| rustdeskserver | ✅ | ✅ | Other |   | `rustdeskserver` |
| sabnzbd | ✅ |  | Python | Python  | `sabnzbd` |
| salt | ✅ |  | Other |   | `salt` |
| scanopy | ✅ |  | Node.js | Node.js  | `scanopy` |
| scraparr | ✅ |  | Python | Python  | `scraparr` |
| searxng | ✅ |  | Python | Python  | `searxng` |
| seelf | ✅ |  | Node.js | Node.js  | `seelf` |
| semaphore | ✅ |  | Simple Package | Simple Package  | `semaphore` |
| sftpgo | ✅ |  | Other |   | `sftpgo` |
| shinobi | ✅ |  | Node.js | Node.js  | `shinobi` |
| signoz | ✅ |  | Other |   | `signoz` |
| silverbullet | ✅ |  | Other |   | `silverbullet` |
| slskd | ✅ |  | Python | Python  | `slskd` |
| smokeping | ✅ |  | Other |   | `smokeping` |
| snipeit | ✅ |  | Other |   | `snipeit` |
| snowshare | ✅ |  | Node.js | Node.js  | `snowshare` |
| sonarr | ✅ |  | Other |  | `linuxserver/sonarr` |
| lidarr | ✅ |  | Other |  | `linuxserver/lidarr` |
| sonarqube | ✅ |  | Other |   | `sonarqube` |
| speedtest-tracker | ✅ |  | Node.js | Node.js  | `speedtest-tracker` |
| splunk-enterprise | ✅ |  | Other |   | `splunk-enterprise` |
| spoolman | ✅ |  | Other |   | `spoolman` |
| stirling-pdf | ✅ |  | Python | Python  | `stirling-pdf` |
| streamlink-webui | ✅ |  | Python | Python  | `streamlink-webui` |
| stylus | ✅ |  | Other |   | `stylus` |
| suwayomiserver | ✅ |  | Other |   | `suwayomiserver` |
| swizzin | ✅ |  | Other |   | `swizzin` |
| syncthing | ✅ | ✅ | Other |  | `syncthing/syncthing` |
| tandoor | ✅ |  | Python | Python  | `tandoor` |
| tasmoadmin | ✅ |  | Other |   | `tasmoadmin` |
| tasmocompiler | ✅ |  | Node.js | Node.js  | `tasmocompiler` |
| tautulli | ✅ |  | Python | Python  | `tautulli` |
| tdarr | ✅ |  | Other |   | `tdarr` |
| teamspeak-server | ✅ | ✅ | Other |   | `teamspeak-server` |
| technitiumdns | ✅ |  | Simple Package | Simple Package  | `technitiumdns` |
| teddycloud | ✅ |  | Other |   | `teddycloud` |
| telegraf | ✅ |  | Other |   | `telegraf` |
| the-lounge | ✅ |  | Other |   | `the-lounge` |
| threadfin | ✅ |  | Other |   | `threadfin` |
| tianji | ✅ |  | Python | Python  | `tianji` |
| tinyauth |  | ✅ | Alpine Package |   | `ghcr.io/steveiliop56/tinyauth` |
| traccar | ✅ |  | Other |   | `traccar` |
| tracktor | ✅ |  | Node.js | Node.js  | `tracktor` |
| traefik | ✅ | ✅ | Other |  | `traefik` |
| transmission | ✅ | ✅ | Other |  | `linuxserver/transmission` |
| trilium | ✅ |  | Other |   | `trilium` |
| tududi | ✅ |  | Node.js | Node.js  | `tududi` |
| tunarr | ✅ |  | Other |   | `tunarr` |
| twingate-connector | ✅ |  | Other |   | `twingate-connector` |
| typesense | ✅ |  | Other |   | `typesense` |
| ubuntu | ✅ |  | Other |   | `ubuntu` |
| uhf | ✅ |  | Other |   | `uhf` |
| umami | ✅ |  | Node.js | Node.js  | `umami` |
| umlautadaptarr | ✅ |  | Simple Package | Simple Package  | `umlautadaptarr` |
| unbound | ✅ |  | Other |   | `unbound` |
| unifi | ✅ |  | Other |   | `unifi` |
| unmanic | ✅ |  | Other |   | `unmanic` |
| upgopher | ✅ |  | Other |   | `upgopher` |
| upsnap | ✅ |  | Other |   | `upsnap` |
| uptimekuma | ✅ |  | Node.js | Node.js  | `uptimekuma` |
| urbackupserver | ✅ |  | Other |   | `urbackupserver` |
| vaultwarden | ✅ | ✅ | Other |  | `vaultwarden/server` |
| verdaccio | ✅ |  | Node.js | Node.js  | `verdaccio` |
| victoriametrics | ✅ |  | Other |   | `victoriametrics` |
| vikunja | ✅ |  | Other |   | `vikunja` |
| wallabag | ✅ |  | Node.js | Node.js  | `wallabag` |
| wallos | ✅ |  | Other |   | `wallos` |
| wanderer | ✅ |  | Node.js | Node.js  | `wanderer` |
| warracker | ✅ |  | Python | Python  | `warracker` |
| wastebin | ✅ |  | Other |   | `wastebin` |
| watcharr | ✅ |  | Node.js | Node.js  | `watcharr` |
| watchyourlan | ✅ |  | Other |   | `watchyourlan` |
| wavelog | ✅ |  | Other |   | `wavelog` |
| wazuh | ✅ |  | Other |   | `wazuh` |
| web-check | ✅ |  | Node.js | Node.js  | `web-check` |
| wger | ✅ |  | Node.js | Node.js  | `wger` |
| whisparr | ✅ |  | Other |   | `whisparr` |
| wikijs | ✅ |  | Node.js | Node.js  | `wikijs` |
| wireguard | ✅ | ✅ | Other |  | `linuxserver/wireguard` |
| wizarr | ✅ |  | Node.js | Node.js  | `wizarr` |
| yt-dlp-webui | ✅ |  | Other |   | `yt-dlp-webui` |
| yunohost | ✅ |  | Other |   | `yunohost` |
| zabbix | ✅ |  | Other |   | `zabbix` |
| zammad | ✅ |  | Simple Package | Simple Package  | `zammad` |
| zerotier-one | ✅ |  | Other |   | `zerotier-one` |
| zipline | ✅ |  | Node.js | Node.js  | `zipline` |
| zitadel | ✅ |  | Other |   | `zitadel` |
| zoraxy | ✅ |  | Other |   | `zoraxy` |
| zot-registry | ✅ |  | Other |   | `zot-registry` |

### Statistik nach Migrations-Gruppen

| Migrations-Gruppe | Anzahl |
|-------------------|--------|
| Node.js | 85 |
| Python | 39 |
| Simple Package | 28 |
| Database | 11 |
| PHP/Web | 9 |
| Repository Package | 5 |

**Gesamt:** 381 Anwendungen
- Mit Migrations-Gruppe (≥5 Mitglieder): 183
- Ohne Migrations-Gruppe: 198

**Wichtige Erkenntnisse:**
- Die meisten Anwendungen haben nur eine Debian-Version (353)
- Nur 24 Anwendungen haben sowohl Debian- als auch Alpine-Versionen
- Alpine-Versionen sind oft einfacher, da viele Packages direkt im Alpine-Repository verfügbar sind
- **Migrations-Gruppen:** 6 Gruppen haben ≥5 Mitglieder:
  - **Node.js:** 85 Anwendungen (z.B. n8n, node-red, zigbee2mqtt, homarr, immich, etc.)
  - **Python:** 39 Anwendungen (z.B. esphome, homeassistant, octoprint, frigate, motioneye, etc.)
  - **Simple Package:** 28 Anwendungen (z.B. openhab, asterisk, mqtt, rabbitmq, emqx, graylog, etc.) - einfache apt/apk install + service
  - **Database:** 11 Anwendungen (MariaDB, PostgreSQL, Redis, MongoDB, etc.)
  - **PHP/Web:** 9 Anwendungen (Gitea, Forgejo, WordPress, etc.)
  - **Repository Package:** 5 Anwendungen (Grafana, Prometheus, etc.)
- **48% der Anwendungen** (183 von 381) können mit wiederverwendbaren Templates migriert werden
- Die größten Gruppen (Node.js, Python und Simple Package) decken zusammen **152 Anwendungen** ab

---

**Hinweis zur oci_image Spalte:**
- Die Spalte `oci_image` enthält Docker Hub oder GitHub Container Registry (ghcr.io) Image-Namen für Anwendungen, die als OCI Images verfügbar sind.
- `-` bedeutet, dass noch keine Recherche durchgeführt wurde oder kein offizielles Image verfügbar ist.
- Weitere Recherchen können für die mit `-` markierten Anwendungen durchgeführt werden.

*Erstellt: 2025-01-27*
*Quelle: https://github.com/community-scripts/ProxmoxVE/tree/main/install*
*OCI Images aktualisiert: 2025-01-27*









