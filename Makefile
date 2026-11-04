.PHONY: build run test vet fmt fmt-check check frontend security csp-hash clean

BINARY ?= build/code-forest

build:
	@mkdir -p "$(dir $(BINARY))"
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$(BINARY)" .

run: build
	"./$(BINARY)"

test:
	go test -race -count=1 -cover ./...

vet:
	go vet ./...

fmt:
	gofmt -w *.go
	npm run format

fmt-check:
	@test -z "$$(gofmt -l *.go)" || (gofmt -l *.go; exit 1)

frontend:
	npm run format:check
	npm test
	npm run check:assets

check: fmt-check vet test frontend

security:
	go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
	npm audit --audit-level=high
	npm run audit:vendor

# Informational only: the Go server generates these hashes from embedded HTML.
csp-hash:
	@node scripts/csp-hashes.js

clean:
	rm -f "$(BINARY)"
