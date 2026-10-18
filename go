#!/usr/bin/env bash
# Short entry point for typing on a phone: bash trikala/go
exec bash "$(dirname "$0")/deploy/deploy.sh" "$@"
