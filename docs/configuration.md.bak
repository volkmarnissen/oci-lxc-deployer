# LXC Manager – Configuration: Applications, Templates & Scripts

This document describes the structure and functionality of configuration in LXC Manager. It is intended for users and developers who want to provide or customize their own applications, templates, or scripts.

---

## 1. Applications

**Applications** are predefined or custom software packages that can be installed in LXC containers (e.g., Home Assistant, Node-RED).  
Configuration is done via JSON files in  
`backend/json/applications/`.

### Example: Home Assistant

```json
{
  "id": "home-assistant",
  "name": "Home Assistant",
  "description": "Open source home automation platform",
  "template": "debian-12-standard",
  "parameters": [
    { "id": "mqtt_host", "type": "string", "default": "localhost" }
  ],
  "scripts": [
    "install-home-assistant.sh"
  ]
}
```

**Key fields:**
- `id`: Unique identifier of the application
- `name`: Display name
- `description`: Description
- `template`: Base template (see below)
- `parameters`: User-adjustable parameters
- `scripts`: List of scripts to execute

---

## 2. Templates

**Templates** define the base for new LXC containers (e.g., Alpine).  
They are stored as JSON files in  
`backend/json/templates/`.

### Example: Debian Template

```json
{
  "id": "debian-12-standard",
  "os": "debian",
  "version": "12",
  "arch": "amd64",
  "description": "Debian 12 Standard LXC Template"
}
```

**Key fields:**
- `id`: Template ID (referenced in Applications)
- `os`, `version`, `arch`: Operating system, version, architecture
- `description`: Description

---

## 3. Scripts

**Scripts** are shell scripts executed during installation or configuration.  
They are located in  
`backend/json/shared/scripts/`.
They can contain "variables" like {{vm_id}}. The values will be provided by the web UI. Or by other scripts.

### Example: Installation Script

```sh
#!/bin/bash
# install-home-assistant.sh

apt-get update
apt-get install -y python3 python3-venv
# ... further installation steps ...
```

**Note:**  
Scripts can contain placeholders like `{{mqtt_host}}`, which are replaced at runtime with parameter values.

---

## 4. Schema Validation

All configuration files are validated against JSON schemas when loaded.  
The schemas are located in  
`backend/schemas/`.

Example:  
- `application.schema.json`
- `template.schema.json`

This ensures that all configurations are consistent and error-free.

---

## 5. Variable Substitution

Placeholders like `{{var}}` in scripts or commands are replaced at runtime.  
The resolution order is:

1. **VM Context (`vmCtx`)**: Static values like `vm_id`, `hostname`, etc.
2. **Outputs**: Values produced by previous commands.
3. **Inputs/Defaults**: User-supplied or default values.

**Special Feature: `host:` Prefix**  
With the new `host:` prefix, you can explicitly reference variables from the host context.  
- First, variables with the `host:` prefix are replaced using values from the VM context (`vmCtx`).
- If a value is not found in the VM context, the system checks `this.outputs` for a value.
- This allows outputs to override only those variables that are not already set by the VM context.

**Example:**
```sh
echo "VM ID: {{vm_id}}, Hostname: {{host:hostname}}, MQTT Host: {{mqtt_host}}"
```
- `vm_id` and `host:hostname` are resolved from the VM context.
- `mqtt_host` is resolved from outputs or inputs.

**Note:**  
This mechanism ensures that critical values like `vm_id` always come from the VM context, while dynamic or user-defined values can be provided via outputs.

---

## 6. The `execute_on` Field

The `execute_on` property in templates specifies where a command or script should be executed:

- `"execute_on": "host"`: The command/script runs directly on the Proxmox host.
- `"execute_on": "lxc"`: The command/script runs inside the LXC container.
- `"execute_on": "host:<hostname>"`: The command/script runs inside the LXC container referenced by hostname (e.g. mariadb").

**Example:**
```json
{
  "id": "mytemplateid",
  "name": "setup-network",
  "execute_on": "host:mariadb"
  ...
}
```
This ensures that scripts are executed in the correct environment, depending on their purpose.

---

## 7. Adding Custom Applications & Templates

1. **Create Application JSON:**  
   Add a new file in `<localdir>/applications/`.

2. **Create Template JSON (if needed):**  
   Add a new file in `<localdir>/templates/`.

3. **Provide Scripts:**  
   Place the required script in `<localdir>/+/scripts/`.

4. **Follow Schema:**  
   The structure must match the respective schema in `backend/schemas/`.

---

## 8. Additional Notes

- Changes to configuration files are applied on the next start of LXC Manager.
- Invalid configurations are rejected when loading (schema validation).
- For complex applications, multiple scripts and parameters can be defined.

---

**Further information:**  
See the examples and templates in the repository under `backend/json/` and the schema files under `backend/schemas/`.