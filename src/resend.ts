export type VerificationEmailSender = (email: string, code: string) => Promise<void>;

export function createResendSender(apiKey: string, from: string, sendRequest: typeof fetch = fetch): VerificationEmailSender {
  return async (email, code) => {
    if (!apiKey || !from) throw new Error("Resend não configurado.");

    const response = await sendRequest("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Seu código de verificação BankTest",
        text: `Seu código de verificação é ${code}. Ele expira em 10 minutos. Se você não tentou criar uma conta, ignore este e-mail.`,
        html: `<div style="font-family:Arial,sans-serif;color:#172435;max-width:480px;margin:auto;padding:24px"><h1 style="font-size:24px">Confirme seu e-mail</h1><p>Use este código para concluir a criação da sua conta BankTest:</p><p style="font-size:36px;letter-spacing:8px;font-weight:700">${code}</p><p>O código expira em 10 minutos. Se você não tentou criar uma conta, ignore este e-mail.</p></div>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`Falha ao enviar e-mail pelo Resend (HTTP ${response.status}).`);
      throw new Error("Falha no envio do e-mail.");
    }
  };
}
