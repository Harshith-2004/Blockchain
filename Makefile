# Makefile for running all JS tests

# Find all test files matching test*.js
TESTS := $(wildcard test*.js)

.PHONY: all test clean

# Default target: run all tests
all: test

# Run each test file with node
test:
	@echo "Running tests: $(TESTS)"
	@for t in $(TESTS); do \
		echo "--- $$t ---"; \
		node $$t || exit 1; \
	done
	@echo "All tests passed!"

# Remove dependencies
clean:
	rm -rf node_modules
	@echo "Dependencies cleaned."
