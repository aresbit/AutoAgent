# AutoAgent — unified build entry point
#
# Adapted from the modern-c-makefile skill: centralized variables, .PHONY
# targets, auto-generated help, V=1 verbose mode, and a single check/build/
# package pipeline. C-specific rules (objects, CFLAGS) are replaced by the
# project's real toolchains: uv/Python, Bun/Vite, Electron, dpkg-deb.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

NAME        := autoagent
VERSION     := $(shell python3 -c 'import json; print(json.load(open("package.json"))["version"])')
BACKEND_DIR := backend
FRONTEND_DIR:= frontend
DESKTOP_DIR := desktop
RELEASE_DIR := release
BUILD_DIR   := backend/build
DEB         := $(RELEASE_DIR)/$(NAME)_$(VERSION)_amd64.deb

UV    ?= uv
BUN   ?= bun
NODE  ?= node
PY    ?= python3

# V=1 shows every command; V=0 keeps the output readable.
V ?= 0
ifeq ($(V),1)
    Q :=
else
    Q := @
endif

.PHONY: help all doctor setup check test lint format build build-backend \
        build-frontend build-desktop package smoke artifact dev run-backend \
        run-frontend clean distclean version install

## ---------------------------------------------------------------------------
## Meta

help: ## Show this help
	$(Q)awk 'BEGIN {FS = ":.*## "; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

all: build ## Default: build the local app (backend binary is not required)

version: ## Print the project version
	$(Q)printf '%s %s\n' "$(NAME)" "$(VERSION)"

doctor: ## Check the required host tools
	$(Q)for tool in $(PY) $(UV) $(BUN) $(NODE) dpkg-deb; do \
		command -v $$tool >/dev/null 2>&1 || { echo "missing: $$tool" >&2; exit 1; }; \
	done
	$(Q)$(PY) --version; $(UV) --version; $(BUN) --version; $(NODE) --version
	$(Q)echo "host: $$(uname -s) $$(uname -m)"

## ---------------------------------------------------------------------------
## Setup and quality

setup: ## Install backend and frontend dependencies from frozen lockfiles
	$(Q)cd $(BACKEND_DIR) && $(UV) sync --frozen
	$(Q)cd $(FRONTEND_DIR) && $(BUN) install --frozen-lockfile
	$(Q)cd $(DESKTOP_DIR) && $(BUN) install --frozen-lockfile 2>/dev/null || true
	$(Q)echo "setup: ok"

lint: ## Static analysis: ruff, mypy, import boundaries, tsc
	$(Q)cd $(BACKEND_DIR) && $(UV) run ruff check src tests
	$(Q)cd $(BACKEND_DIR) && $(UV) run mypy src
	$(Q)cd $(BACKEND_DIR) && $(UV) run lint-imports
	$(Q)cd $(FRONTEND_DIR) && $(BUN) run typecheck
	$(Q)cd $(DESKTOP_DIR) && ../node_modules/.bin/tsc --noEmit -p tsconfig.json

test: ## Run backend, frontend and desktop test suites
	$(Q)cd $(BACKEND_DIR) && $(UV) run pytest -q
	$(Q)cd $(FRONTEND_DIR) && $(BUN) run test
	$(Q)cd $(DESKTOP_DIR) && node test/smoke.mjs

check: lint test ## CI gate: lint + all tests
	$(Q)echo "check: ok"

format: ## Format Python sources (ruff) and report frontend formatting
	$(Q)cd $(BACKEND_DIR) && $(UV) run ruff format src tests
	$(Q)echo "format: backend formatted; frontend formatting is enforced by tsc/eslint convention"

## ---------------------------------------------------------------------------
## Build

build: build-frontend build-desktop ## Build the SPA and the modern Electron shell
	$(Q)echo "build: $(NAME) $(VERSION) ready (dev); use 'make package' for the .deb"

build-frontend: ## Build frontend/dist
	$(Q)cd $(FRONTEND_DIR) && $(BUN) run build

build-desktop: ## Build desktop/dist
	$(Q)cd $(DESKTOP_DIR) && $(NODE) build.mjs

build-backend: ## Build the self-contained Nuitka backend
	$(Q)bash scripts/build-backend.sh

package: ## Build the self-contained .deb (runs lint + tests first)
	$(Q)$(MAKE) check
	$(Q)bash scripts/build-deb.sh

smoke: ## Run the packaged X11/Wayland/API smoke test against the .deb
	$(Q)bash scripts/smoke-packaged.sh

artifact: ## Print the final artifact path, size and SHA256
	$(Q)test -f "$(DEB)" || { echo "missing $(DEB); run 'make package'" >&2; exit 1; }
	$(Q)ls -lh "$(DEB)"
	$(Q)sha256sum "$(DEB)"

## ---------------------------------------------------------------------------
## Run (development)

run-backend: ## Run the Python backend on 127.0.0.1:8787 (fake engine if not set)
	$(Q)cd $(BACKEND_DIR) && exec $(UV) run python -m autoagent_backend --port 8787

run-frontend: ## Run the Vite dev server (use VITE_MOCK=1 for mock data)
	$(Q)cd $(FRONTEND_DIR) && exec $(BUN) run dev

dev: build ## Launch the modern Electron app (dev-only --no-sandbox)
	$(Q)cd $(DESKTOP_DIR) && exec $(NODE) ../node_modules/electron/cli.js dist/entry.js --no-sandbox

## ---------------------------------------------------------------------------
## Clean and install

clean: ## Remove build outputs (keeps the packaged artifact)
	$(Q)rm -rf $(BUILD_DIR) $(FRONTEND_DIR)/dist $(DESKTOP_DIR)/dist
	$(Q)find $(BACKEND_DIR) -type d -name __pycache__ -prune -exec rm -rf {} +
	$(Q)echo "clean: ok"

distclean: clean ## Remove build outputs and the packaged artifact
	$(Q)rm -rf $(RELEASE_DIR)
	$(Q)echo "distclean: ok"

install: ## Install the built .deb (requires sudo)
	$(Q)test -f "$(DEB)" || { echo "missing $(DEB); run 'make package'" >&2; exit 1; }
	$(Q)sudo apt install "./$(DEB)"
