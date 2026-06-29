.PHONY: build run test clean deploy

BINARY=code-forest-backend

build:
	go build -ldflags="-s -w" -o $(BINARY) main.go

run: build
	./$(BINARY)

test:
	go test -v -count=1 -cover ./...

clean:
	rm -f $(BINARY)

deploy: build
	sudo systemctl restart code-forest
