PORT := $(shell node -e "console.log(require('./config.json').port)")
export PORT

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f
