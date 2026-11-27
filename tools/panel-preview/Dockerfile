ARG ESPHOME_IMAGE=ghcr.io/esphome/esphome:2026.11.0b6
FROM ${ESPHOME_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsdl2-dev xvfb x11-utils xdotool \
 && rm -rf /var/lib/apt/lists/*
