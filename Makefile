PORT := $(shell jq .port config.json)
export PORT

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f
