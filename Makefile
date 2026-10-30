SHELL := /bin/bash
.DEFAULT_GOAL := check

NPM ?= npm
NODE ?= node
GITLEAKS_BIN ?= gitleaks

.PHONY: check test build pack verify-boundary verify-rpc verify-installed-ui public-surface-audit secret-scan package-audit public-gate release-check ci clean

check:
	$(NPM) run check

test:
	$(NPM) test

build:
	$(NPM) run build

pack:
	$(NPM) run pack:all

verify-boundary:
	$(NPM) run verify:boundary

verify-rpc:
	$(NPM) run verify:rpc

verify-installed-ui:
	$(NPM) run verify:installed-ui

public-surface-audit:
	$(NODE) scripts/public-surface-audit.mjs

secret-scan:
	GITLEAKS_BIN=$(GITLEAKS_BIN) $(NODE) scripts/secret-scan.mjs

package-audit:
	$(NPM) audit --omit=dev --audit-level=high --ignore-scripts

public-gate:
	$(MAKE) public-surface-audit
	$(MAKE) secret-scan
	$(MAKE) check
	$(MAKE) test
	$(MAKE) verify-boundary
	$(MAKE) verify-rpc
	$(MAKE) pack
	$(MAKE) verify-installed-ui
	$(MAKE) package-audit
	git diff --check

release-check: public-gate

ci: public-gate

clean:
	rm -rf .artifacts packages/agentkit-harness-core/dist packages/agentkit-harness-node/dist packages/agentkit-harness-ui/markdown/dist
