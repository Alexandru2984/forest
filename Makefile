.PHONY: build run test vet fmt check csp-hash clean deploy

BINARY=code-forest-backend

build:
	go build -ldflags="-s -w" -o $(BINARY) main.go

run: build
	./$(BINARY)

test:
	go test -v -count=1 -cover ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

# Verify formatting + vet + tests in one shot (mirrors CI).
check:
	@test -z "$$(gofmt -l .)" || (echo "gofmt needed:"; gofmt -l .; exit 1)
	go vet ./...
	go test -count=1 -cover ./...

# Recompute the CSP sha256 for the inline <script type="importmap"> block.
csp-hash:
	@python3 -c "import re,hashlib,base64; h=open('public/index.html').read(); m=re.search(r'<script type=\"importmap\">(.*?)</script>', h, re.S); print('sha256-'+base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode())"

clean:
	rm -f $(BINARY)

deploy: build
	sudo systemctl restart code-forest
