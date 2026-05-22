FILE ?= prd.md
SERVER_HOST ?= 127.0.0.1
SERVER_PORT ?= 4173
WEB_HOST ?= 127.0.0.1
WEB_PORT ?= 5173

.PHONY: run check install

run:
	@if [ ! -d node_modules ]; then \
		echo "Installing npm dependencies..."; \
		npm ci; \
	fi
	@echo "Starting Xuanniao API on http://$(SERVER_HOST):$(SERVER_PORT)"
	@echo "Starting Xuanniao web on http://$(WEB_HOST):$(WEB_PORT)"
	@HOST=$(SERVER_HOST) PORT=$(SERVER_PORT) npm start -- $(FILE) & \
	server_pid=$$!; \
	trap 'kill $$server_pid 2>/dev/null || true' INT TERM EXIT; \
	sleep 1; \
	if ! kill -0 $$server_pid 2>/dev/null; then \
		wait $$server_pid; \
		exit $$?; \
	fi; \
	XUANNIAO_API_HOST=$(SERVER_HOST) XUANNIAO_API_PORT=$(SERVER_PORT) npm exec vite -- --host $(WEB_HOST) --port $(WEB_PORT)

check:
	@npm run check

install:
	@npm ci
