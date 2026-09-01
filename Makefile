# ============================================================
# Autonomous Income Node — Makefile
# ============================================================

.PHONY: build start stop logs backup status install dev test clean help

# Default target
.DEFAULT_GOAL := help

help: ## Show this help message
	@echo "Autonomous Income Node — Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	pnpm install

build: ## Build TypeScript to JavaScript
	pnpm build

start: ## Start the agent (Docker Compose)
	docker compose up -d
	@echo "Agent started. Check status with: make status"

stop: ## Stop the agent (Docker Compose)
	docker compose down
	@echo "Agent stopped."

restart: ## Restart the agent
	docker compose restart agent

logs: ## Follow agent logs
	docker compose logs -f agent

logs-all: ## Follow all service logs
	docker compose logs -f

status: ## Show agent status
	@echo "=== Docker Status ==="
	@docker compose ps 2>/dev/null || echo "Docker not running"
	@echo ""
	@echo "=== Health Check ==="
	@curl -sf http://localhost:3000/health | python3 -m json.tool 2>/dev/null || echo "Agent not responding on :3000"
	@echo ""
	@echo "=== Metrics ==="
	@curl -sf http://localhost:9090/metrics | python3 -m json.tool 2>/dev/null || echo "Metrics not available on :9090"

backup: ## Create database backup
	@echo "Creating backup..."
	@mkdir -p data/backups
	@cp data/agent.db "data/backups/agent_$(shell date +%Y%m%d_%H%M%S).db" 2>/dev/null && echo "Backup created" || echo "No database found to backup"

build-docker: ## Build Docker image
	docker compose build

clean: ## Remove build artifacts
	rm -rf dist
	rm -rf node_modules/.cache

clean-all: ## Remove all artifacts including node_modules
	rm -rf dist node_modules packages/cli/node_modules

dev: ## Start in development mode (hot reload)
	pnpm dev

test: ## Run all tests
	pnpm test

test-watch: ## Run tests in watch mode
	pnpm test:watch

clone-reference: ## Clone Conway-Research/automaton as reference
	@if [ -d "references/web4-source/.git" ]; then \
		echo "Reference repo already exists. Pulling latest..."; \
		cd references/web4-source && git pull; \
	else \
		echo "Cloning Conway-Research/automaton..."; \
		git clone https://github.com/Conway-Research/automaton references/web4-source; \
	fi
