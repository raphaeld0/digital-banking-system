import assert from "node:assert/strict";
import { test } from "node:test";
import { createResendSender } from "./resend.js";

test("envio usa a API do Resend com remetente, destinatário e código", async () => {
  let requestSeen = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    requestSeen = true;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test_key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.from, "BankTest <teste@example.com>");
    assert.deepEqual(body.to, ["pessoa@example.com"]);
    assert.match(body.text, /004205/);
    return new Response(JSON.stringify({ id: "id-de-teste" }), { status: 200 });
  };

  const send = createResendSender("test_key", "BankTest <teste@example.com>", fakeFetch);
  await send("pessoa@example.com", "004205");
  assert.equal(requestSeen, true);
});
