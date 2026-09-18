import test from "node:test";
import assert from "node:assert/strict";
import {
  balance,
  invoiceStatus,
  toMinorUnits,
  csvCell,
  subscriberLoginEmail,
  serviceLifecycleActions,
} from "../src/lib/domain.ts";
const invoice = {
  id: "1",
  organization_id: "org1",
  number: "INV-1",
  subscriber_id: "s1",
  issued_on: "2026-09-01",
  due_on: "2026-09-10",
  description: "Monthly service",
  total_minor: 129900,
  paid_minor: 100000,
  currency: "PHP",
};
test("balances use integer minor units", () =>
  assert.equal(balance(invoice), 29900));
test("past due partial payment is overdue", () =>
  assert.equal(invoiceStatus(invoice, "2026-09-14"), "overdue"));
test("due today is not overdue", () =>
  assert.equal(invoiceStatus(invoice, "2026-09-10"), "open"));
test("paid invoices are never overdue", () =>
  assert.equal(
    invoiceStatus({ ...invoice, paid_minor: 129900 }, "2026-09-14"),
    "paid",
  ));
test("money parsing is exact", () => {
  assert.equal(toMinorUnits("1299.99"), 129999);
  assert.equal(toMinorUnits("0.01"), 1);
  assert.equal(toMinorUnits("12.5"), 1250);
});
test("ambiguous, negative and excessive precision amounts rejected", () => {
  for (const amount of ["-1", "1e3", "0.001", "Infinity", "1,000", "NaN"])
    assert.throws(() => toMinorUnits(amount));
});
test("CSV escapes quotes and formula injection", () => {
  assert.equal(csvCell('A "B"'), '"A ""B"""');
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
});
test("subscriber account number maps to a private Auth email", () => {
  assert.equal(
    subscriberLoginEmail(" sw-000123 "),
    "sw-000123@accounts.southwoods.invalid",
  );
});
test("malformed subscriber account numbers are rejected", () => {
  for (const account of ["ab", "name@example.com", "../../admin", "SW 123"])
    assert.throws(() => subscriberLoginEmail(account));
});
test("service lifecycle actions match each recorded state", () => {
  assert.deepEqual(serviceLifecycleActions("pending"), [
    "activate",
    "change_plan",
    "terminate",
  ]);
  assert.deepEqual(serviceLifecycleActions("active"), [
    "suspend",
    "change_plan",
    "terminate",
  ]);
  assert.deepEqual(serviceLifecycleActions("suspended"), [
    "reconnect",
    "change_plan",
    "terminate",
  ]);
  assert.deepEqual(serviceLifecycleActions("terminated"), []);
});
