#!/usr/bin/env python3
import json
import sys

# This script tests Python shebang execution
# It outputs JSON to stdout and logs to stderr

test_param = "{{ test_param }}"
test_value = "{{ test_value }}"

# Log to stderr (not stdout)
print(f"Python script executed successfully with test_param={test_param}, test_value={test_value}", file=sys.stderr)

# Output JSON to stdout (required format)
output = [
    {"id": "python_executed", "value": True},
    {"id": "test_param_value", "value": test_param},
    {"id": "test_value_value", "value": test_value},
    {"id": "python_version", "value": f"{sys.version_info.major}.{sys.version_info.minor}"}
]

print(json.dumps(output, indent=2))


