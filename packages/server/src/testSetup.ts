import { setScryptCostForTests } from "./auth";

// Hashing a password the way Friend really does takes about a second; a test run makes hundreds. The tests that check the real cost set it back.
setScryptCostForTests(1024);
