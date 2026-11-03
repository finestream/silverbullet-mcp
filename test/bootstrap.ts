// node test/bootstrap.ts   — bootstrap the instance at SB_URL (default http://127.0.0.1:3300)
// with SB_ADMIN_PASSWORD (default admin-test-password). node test/run.ts does this too.
import { bootstrap } from "./lib/bootstrap.ts";

await bootstrap();
