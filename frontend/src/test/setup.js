// IndexedDB is not available in the node test environment; the in-memory
// implementation lets the vault and local store be tested for real rather
// than behind a mock of our own code.
import "fake-indexeddb/auto";
