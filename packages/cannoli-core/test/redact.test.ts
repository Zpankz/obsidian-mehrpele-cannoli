import { afterEach, describe, expect, it, vi } from "vitest";
import type { Persistor } from "../src/persistor";
import {
  redactingPersistor,
  redactRequest,
  redactSecrets,
  redactEventData,
  streamRedactor,
} from "../src/runtime/redact";
import { secretResolverFromRecord, withProviderKeys } from "../src/secrets";
import { runCanvas } from "./helpers/run";

const box = { x: 0, y: 0, width: 200, height: 100 };
const SECRET_VALUE = 'tok-"quoted"\\path-0123456789';

/** A Persistor that keeps every call it receives, serialised, in memory. */
function memoryPersistor(): { persistor: Persistor; log: string[] } {
  const log: string[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      log.push(`${method} ${JSON.stringify(args)}`);
    };
  const persistor: Persistor = {
    start: record("start"),
    editNode: record("editNode"),
    editEdge: record("editEdge"),
    addError: record("addError"),
    addWarning: record("addWarning"),
    editOriginalParallelGroupLabel: record("editOriginalParallelGroupLabel"),
    setConfig: () => {},
  };
  return { persistor, log };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redaction", () => {
  it("uses the longest secret independently of every chunk partition", () => {
    const secrets = secretResolverFromRecord({
      LONG: "abcdefghi",
      SHORT: "abcdef",
    });
    const value = "abcdefghi";
    for (let mask = 0; mask < 256; mask++) {
      const redact = streamRedactor(secrets);
      let output = "",
        start = 0;
      for (let i = 1; i < value.length; i++) {
        if (mask & (1 << (i - 1))) {
          output += redact(value.slice(start, i));
          start = i;
        }
      }
      output += redact(value.slice(start)) + redact("", true);
      expect(output).toBe(redactSecrets(value, secrets));
    }
  });

  it("flushes a shorter secret at EOF or when a longer prefix no longer matches", () => {
    const secrets = secretResolverFromRecord({
      LONG: "abcdefghi",
      SHORT: "abcdef",
    });
    const eof = streamRedactor(secrets);
    expect(eof("abcdef")).toBe("");
    expect(eof("", true)).toBe("«secret:SHORT»");
    const broken = streamRedactor(secrets);
    expect(broken("abcdef")).toBe("");
    expect(broken("!")).toBe("«secret:SHORT»!");
  });

  it("redacts URL objects and nested event metadata without mutating transport data", () => {
    const url = new URL("https://example.test/image?key=secret-credential");
    const original = {
      image: url,
      metadata: { nested: [{ token: "secret-credential" }] },
    };
    const copy = redactEventData(
      original,
      secretResolverFromRecord({ KEY: "secret-credential" }),
    );
    expect(copy.image).toBe("https://example.test/image?key=«secret:KEY»");
    expect(copy.metadata.nested[0].token).toBe("«secret:KEY»");
    expect(original.image.href).toContain("secret-credential");
    expect(original.metadata.nested[0].token).toBe("secret-credential");
  });

  it("redacts provider keys even when their synthetic name is already a user secret", () => {
    const secrets = withProviderKeys(
      secretResolverFromRecord({ "provider-key-ollama": "user-secret-value" }),
      [{ provider: "ollama", apiKey: "provider-secret-value" }],
    );
    const redacted = redactSecrets(
      "user-secret-value provider-secret-value",
      secrets,
    );
    expect(redacted).toBe(
      "«secret:provider-key-ollama» «secret:provider-key-ollama-2»",
    );
  });
  it("redactRequest redacts tool schemas without mutating the input", () => {
    const secrets = secretResolverFromRecord({ MY_SECRET: "hunter2-secret" });
    const request = {
      messages: [{ role: "user", content: "pick one" }],
      model: "gpt-4o-mini",
      function_call: { name: "note_select" },
      functions: [
        {
          name: "note_select",
          description: "Choose hunter2-secret or another note",
          parameters: {
            type: "object",
            properties: {
              note: { type: "string", enum: ["hunter2-secret", "Plain"] },
            },
          },
        },
      ],
    };
    const before = JSON.parse(JSON.stringify(request));
    const out = redactRequest(request, secrets);
    expect(out.functions?.[0].description).toBe(
      "Choose «secret:MY_SECRET» or another note",
    );
    expect(out.functions?.[0].parameters).toEqual({
      type: "object",
      properties: {
        note: { type: "string", enum: ["«secret:MY_SECRET»", "Plain"] },
      },
    });
    expect(out.model).toBe("gpt-4o-mini");
    expect(request).toEqual(before);
  });

  it("secret values never reach persisted text", async () => {
    const canvas = {
      nodes: [
        {
          id: "content",
          type: "text",
          // Not a lone {{ref}}: that would be a reference node, not a formatter.
          text: "Key: {{MY_SECRET}}",
          color: "6",
          ...box,
        },
        { id: "out", type: "text", text: "", color: "6", ...box, x: 400 },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "content",
          fromSide: "right",
          toNode: "out",
          toSide: "left",
        },
      ],
    };
    const { persistor, log } = memoryPersistor();
    const { finished, stoppages, run } = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        persistor,
        secrets: secretResolverFromRecord({ MY_SECRET: SECRET_VALUE }),
      },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    // The secret did resolve inside the run...
    expect(run.graph["out"].text).toContain(SECRET_VALUE);
    // ...but nothing handed to the persistor carries it.
    const persisted = log.join("\n");
    expect(log.some((l) => l.startsWith("editNode"))).toBe(true);
    expect(persisted).not.toContain("tok-");
    expect(persisted).toContain("«secret:MY_SECRET»");
  });

  it("leaves ids, colours and edges intact while redacting the text", async () => {
    // The secret's value is also a node id: only text may change.
    const ID_VALUE = "out-node-0001";
    const canvas = {
      nodes: [
        {
          id: "content",
          type: "text",
          text: "Key: {{MY_SECRET}}",
          color: "6",
          ...box,
        },
        { id: ID_VALUE, type: "text", text: "", color: "6", ...box, x: 400 },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "content",
          fromSide: "right",
          toNode: ID_VALUE,
          toSide: "left",
        },
      ],
    };
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method, args: structuredClone(args) });
      };
    const persistor: Persistor = {
      start: record("start"),
      editNode: record("editNode"),
      editEdge: record("editEdge"),
      addError: record("addError"),
      addWarning: record("addWarning"),
      editOriginalParallelGroupLabel: record("editOriginalParallelGroupLabel"),
      setConfig: () => {},
    };
    const { stoppages } = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        persistor,
        secrets: secretResolverFromRecord({ MY_SECRET: ID_VALUE }),
      },
    });
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);

    const start = calls.find((c) => c.method === "start");
    const data = start?.args[0] as {
      nodes: {
        id: string;
        color?: string;
        cannoliData: { groups: string[] };
      }[];
      edges: {
        id: string;
        fromNode: string;
        toNode: string;
        cannoliData: { dependencies: string[] };
      }[];
    };
    expect(data.nodes.map((n) => n.id)).toEqual(["content", ID_VALUE]);
    expect(data.nodes.map((n) => n.color)).toEqual(["6", "6"]);
    expect(data.edges[0]).toMatchObject({
      id: "e1",
      fromNode: "content",
      toNode: ID_VALUE,
    });

    const outEdits = calls.filter(
      (c) =>
        c.method === "editNode" &&
        (c.args[0] as { id: string }).id === ID_VALUE,
    );
    expect(outEdits.length).toBeGreaterThan(0);
    const last = outEdits[outEdits.length - 1].args[0] as {
      id: string;
      text: string;
      cannoliData: { text: string };
    };
    expect(last.id).toBe(ID_VALUE);
    expect(last.text).toBe("Key: «secret:MY_SECRET»");
    expect(last.cannoliData.text).toBe("Key: «secret:MY_SECRET»");
  });

  it("redacts only text-bearing fields of persisted objects", async () => {
    const VALUE = "#a1b2c3";
    const seen: unknown[] = [];
    const inner: Persistor = {
      start: async (d) => void seen.push(d),
      editNode: async (n) => void seen.push(n),
      editEdge: async (e) => void seen.push(e),
      addError: async () => {},
      addWarning: async () => {},
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const wrapped = redactingPersistor(
      inner,
      secretResolverFromRecord({ COLOR: VALUE }),
    );
    const group = {
      id: VALUE,
      type: "group",
      label: `group ${VALUE}`,
      color: VALUE,
      file: VALUE,
      ...box,
      cannoliData: {
        text: `t ${VALUE}`,
        groups: [VALUE],
        dependencies: [VALUE],
        originalObject: VALUE,
        kind: "group",
        type: "basic",
        status: "pending",
      },
    };
    const edge = {
      id: VALUE,
      fromNode: VALUE,
      toNode: VALUE,
      fromSide: "right",
      toSide: "left",
      color: VALUE,
      label: `label ${VALUE}`,
      cannoliData: {
        text: `name ${VALUE}`,
        crossingInGroups: [VALUE],
        crossingOutGroups: [VALUE],
        content: { name: `c ${VALUE}` },
        messages: [
          {
            role: "user",
            content: `m ${VALUE}`,
            function_call: { name: "f", args: { a: `x ${VALUE}` } },
          },
        ],
        versions: [{ header: `h ${VALUE}`, subHeader: null }],
        dependencies: [VALUE],
      },
    };
    await wrapped.start({
      nodes: [group],
      edges: [edge],
    } as unknown as Parameters<Persistor["start"]>[0]);

    const out = seen[0] as { nodes: (typeof group)[]; edges: (typeof edge)[] };
    const P = "«secret:COLOR»";
    expect(out.nodes[0]).toEqual({
      ...group,
      label: `group ${P}`,
      cannoliData: { ...group.cannoliData, text: `t ${P}` },
    });
    expect(out.edges[0]).toEqual({
      ...edge,
      label: `label ${P}`,
      cannoliData: {
        ...edge.cannoliData,
        text: `name ${P}`,
        content: { name: `c ${P}` },
        messages: [
          {
            role: "user",
            content: `m ${P}`,
            function_call: { name: "f", args: { a: `x ${P}` } },
          },
        ],
        versions: [{ header: `h ${P}`, subHeader: null }],
      },
    });
  });

  it("reads each secret once per persistor call, not once per string", async () => {
    let reads = 0;
    const counting = {
      get: (name: string) => {
        reads++;
        return name === "MY_SECRET" ? SECRET_VALUE : null;
      },
      names: () => ["MY_SECRET", "OTHER"],
    };
    const inner: Persistor = {
      start: async () => {},
      editNode: async () => {},
      editEdge: async () => {},
      addError: async () => {},
      addWarning: async () => {},
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      type: "text",
      text: `node ${i}`,
      ...box,
      cannoliData: { text: `node ${i}`, groups: [], dependencies: [] },
    }));
    await redactingPersistor(inner, counting).start({
      nodes,
      edges: [],
    } as unknown as Parameters<Persistor["start"]>[0]);
    expect(reads).toBe(2);
  });

  it("skips values shorter than six characters", () => {
    const secrets = secretResolverFromRecord({ PORT: "3", CODE: "abcde" });
    expect(redactSecrets("color 3, code abcde", secrets)).toBe(
      "color 3, code abcde",
    );
    expect(
      redactSecrets("abcdef", secretResolverFromRecord({ SIX: "abcdef" })),
    ).toBe("«secret:SIX»");
  });

  it("replaces longer values first and in one pass", () => {
    const secrets = secretResolverFromRecord({
      SHORT: "abcdef",
      LONG: "abcdefghi",
      WORD: "secret",
    });
    expect(redactSecrets("xabcdefghix abcdef secret", secrets)).toBe(
      "x«secret:LONG»x «secret:SHORT» «secret:WORD»",
    );
  });

  it("skips empty and whitespace-only values and treats values literally", () => {
    const values: Record<string, string | null> = {
      EMPTY: "",
      SPACE: "       ",
      NULL: null,
      DOTS: "a.b.c.d",
    };
    const secrets = {
      get: (name: string) => values[name] ?? null,
      names: () => Object.keys(values),
    };
    expect(redactSecrets("a b       c axbxcxd a.b.c.d", secrets)).toBe(
      "a b       c axbxcxd «secret:DOTS»",
    );
    expect(redactSecrets("", secrets)).toBe("");
  });

  it("redacts a secret carried from a content node into a call prompt", async () => {
    const canvas = {
      nodes: [
        {
          id: "content",
          type: "text",
          text: "Key: {{MY_SECRET}}",
          color: "6",
          ...box,
        },
        { id: "call", type: "text", text: "Summarise {{key}}", ...box, x: 400 },
        { id: "out", type: "text", text: "", color: "6", ...box, x: 800 },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "content",
          fromSide: "right",
          toNode: "call",
          toSide: "left",
          label: "key",
        },
        {
          id: "e2",
          fromNode: "call",
          fromSide: "right",
          toNode: "out",
          toSide: "left",
        },
      ],
    };
    const requests: string[] = [];
    const { stoppages } = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        secrets: secretResolverFromRecord({ MY_SECRET: SECRET_VALUE }),
        llmConfigs: [{ provider: "openai", model: "gpt-4o", apiKey: "x" }],
        // The spies below stand in for the LangChain provider.
        providerEngine: "langchain",
      },
      beforeStart: (run) => {
        const llm = run.llm!;
        vi.spyOn(llm, "getCompletion").mockImplementation(async (request) => {
          requests.push(JSON.stringify(request.messages));
          return { role: "assistant", content: "ok" };
        });
        vi.spyOn(llm, "getCompletionStream").mockImplementation(
          async (request) => {
            requests.push(JSON.stringify(request.messages));
            return null as never;
          },
        );
      },
    });
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(requests.length).toBeGreaterThan(0);
    const sent = requests.join("\n");
    expect(sent).toContain("«secret:MY_SECRET»");
    expect(sent).not.toContain("tok-");
  });
});
