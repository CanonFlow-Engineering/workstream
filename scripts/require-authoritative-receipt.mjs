import { readFileSync } from "node:fs";

const [receiptPath, expectedVerdict] = process.argv.slice(2);
if (receiptPath === undefined || expectedVerdict === undefined) {
  throw new Error(
    "Usage: require-authoritative-receipt <receipt-path> <verdict>",
  );
}
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const verdict =
  typeof receipt.verdict === "string" ? receipt.verdict : receipt.verdict?.kind;
if (receipt.authoritative !== true || verdict !== expectedVerdict) {
  throw new Error(
    `NON_AUTHORITATIVE_EVIDENCE: expected authoritative ${expectedVerdict}, received ${String(verdict)} / ${String(receipt.authoritative)}.`,
  );
}
