                                                                                             
// retention keeps only the newest records.
import { describe, expect, test } from "bun:test";
import { RunViewPersistor } from "../src/run/persistor";
import { dayOf, makeRunId, pruneRecords, recordPath, RUNS_DIR, writeRecord } from "../src/run/records";
import { createRedactor, secretForms } from "../src/run/redact";
import { fakeApp } from "./support/fake-app";

const KEY = "fake-key-for-tests-aaaa+/=?&";
const ID = "mehrpele-flows-key-openai";
const LABEL = `‹secret:${ID}›`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("redact", () => {
  const r = createRedactor([{ id: ID, value: KEY }]);

  test("plain, URL-encoded, form-encoded, base64 and base64url forms", () => {
    const enc = encodeURIComponent(KEY);
    expect(r.text(`Bearer ${KEY}`)).toBe(`Bearer ${LABEL}`);
    expect(r.text(`?key=${enc}`)).toBe(`?key=${LABEL}`);
    expect(r.text(`?key=${enc.replace(/%20/g, "+")}`)).toBe(`?key=${LABEL}`);
    expect(r.text(`Basic ${b64(KEY)}`)).toBe(`Basic ${LABEL}`);
    expect(r.text(b64(KEY).replace(/=+$/, ""))).toBe(LABEL);
    const url = b64(KEY).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(r.text(`x${url}y`)).toBe(`x${LABEL}y`);
    expect(r.text("nothing here")).toBe("nothing here");
  });

  test("every occurrence, in deep data, keys and Errors", () => {
    const data = {
      a: [`${KEY} and ${KEY}`],
      [KEY]: { n: 1, b: true, z: null, err: new Error(`401 for ${KEY}`) },
    };
    const out = r.deep(data) as Record<string, any>;
    expect(out.a[0]).toBe(`${LABEL} and ${LABEL}`);
    expect(out[LABEL].n).toBe(1);
    expect(out[LABEL].b).toBe(true);
    expect(out[LABEL].z).toBeNull();
    expect(out[LABEL].err).toBe(`401 for ${LABEL}`);
    expect(JSON.stringify(out)).not.toContain(KEY);
    // The input is not mutated.
    expect(data.a[0]).toContain(KEY);
  });

  test("empty values redact nothing and forms under 4 characters are dropped", () => {
    const none = createRedactor([{ id: "x", value: "" }]);
    expect(none.text("abc")).toBe("abc");
    expect(secretForms("ab")).toEqual(["YWI="]);
    expect(secretForms("abcd")).toContain("abcd");
  });

  test("the persistor redacts error and warning messages", async () => {
    const p = new RunViewPersistor();
    p.setRedactor(r.text);
    p.seed({ nodes: [{ id: "n1", text: "Call" }, { id: "n2", text: "Other" }] });
    await p.addError("n1", `401 Unauthorized: ${KEY}`);
    await p.addWarning("n2", `slow: ${b64(KEY)}`);
    expect(p.list().map((row) => [row.status, row.message])).toEqual([
      ["error", `401 Unauthorized: ${LABEL}`],
      ["warning", `slow: ${LABEL}`],
    ]);
  });
});

describe("records", () => {
  test("run ids sort by start time and paths sit under the UTC day", () => {
    const d = new Date(Date.UTC(2026, 10, 4, 16, 54, 0));
    expect(makeRunId(d, () => 0)).toBe("20261104T165400Z-0000");
    expect(makeRunId(d)).toMatch(/^20261104T165400Z-[0-9a-z]{4}$/);
    expect(dayOf(d)).toBe("2026-11-04");
    expect(recordPath("R", d)).toBe(`${RUNS_DIR}/2026-11-04/R.json`);
  });

  const rec = (runId: string) => ({ version: 1, runId }) as any;

  test("retention keeps the newest `keep` records and removes empty day folders", async () => {
    const fake = fakeApp();
    const a = fake.app.vault.adapter as any;
    const d1 = new Date(Date.UTC(2026, 10, 3, 10));
    const d2 = new Date(Date.UTC(2026, 10, 4, 10));
    await writeRecord(a, rec(makeRunId(d1, () => 0)), d1, 50);
    await writeRecord(a, rec(makeRunId(new Date(d1.getTime() + 1000), () => 0)), d1, 50);
    await writeRecord(a, rec(makeRunId(d2, () => 0)), d2, 50);
    expect(fake.folders.has(`${RUNS_DIR}/2026-11-03`)).toBe(true);

    const p = await writeRecord(a, rec(makeRunId(new Date(d2.getTime() + 1000), () => 0)), d2, 2);
    expect(p).toBe(`${RUNS_DIR}/2026-11-04/20261104T100001Z-0000.json`);
    const left = [...fake.files.keys()].filter((f) => f.startsWith(RUNS_DIR)).sort();
    expect(left).toEqual([`${RUNS_DIR}/2026-11-04/20261104T100000Z-0000.json`, `${RUNS_DIR}/2026-11-04/20261104T100001Z-0000.json`]);
    expect(fake.folders.has(`${RUNS_DIR}/2026-11-03`)).toBe(false);
    expect(fake.calls.filter((c) => c.startsWith("adapter.rmdir"))).toEqual([`adapter.rmdir ${RUNS_DIR}/2026-11-03`]);
    expect(await pruneRecords(a, 1)).toBe(1);
    expect(await pruneRecords(fakeApp().app.vault.adapter as any, 1)).toBe(0);
  });

  test("records go through the adapter only, never the vault API", async () => {
    const fake = fakeApp();
    const d = new Date(Date.UTC(2026, 10, 4));
    await writeRecord(fake.app.vault.adapter as any, rec("R"), d, 50);
    expect(fake.calls).toEqual([`adapter.write ${RUNS_DIR}/2026-11-04/R.json`]);
    expect(JSON.parse(fake.files.get(`${RUNS_DIR}/2026-11-04/R.json`)!)).toEqual({ version: 1, runId: "R" });
  });
});
