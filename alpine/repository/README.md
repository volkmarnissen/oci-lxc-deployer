Alpine abuild repository

This directory contains abuild-ready package skeletons and helper scripts to build APKs that install and manage OpenRC services.

- modbus2mqtt: Installs a `modbus2mqtt` binary and an OpenRC service named `modbus2mqtt`. Post-install enables and starts the service.
- scripts/mk-openrc-package.sh: Helper to generate similar packages.

Quick build (inside Alpine build environment):

1. Ensure abuild keys are set up
   - abuild-keygen -a -i
2. Build the package
   - cd modbus2mqtt
   - abuild -r

Note: The binary placeholder is in `modbus2mqtt/files/modbus2mqtt`. Replace it with the real binary or adjust APKBUILD `source` to fetch upstream artifacts.
