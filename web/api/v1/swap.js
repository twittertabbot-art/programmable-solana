// Vercel serverless function: POST /api/v1/swap. The work is in web/api/_trade.js, the same
// module web/serve.js calls for the self-hosted site. API.md is the reference.
import { handleRequest } from "../_trade.js";

export default function handler(req, res) {
  return handleRequest(req, res, "swap");
}
