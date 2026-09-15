# Testing

Rust debug and release suites cover account layouts, order book, settlement,
registry, scratch, risk and instruction vectors. TypeScript covers SDK,
authentication, execution boundaries, markets, oracle keeper and indexer
primitives. Runtime tests load the SBF artifact only when the selected Agave,
SBPF and harness versions are compatible; native mocks are not runtime evidence.
