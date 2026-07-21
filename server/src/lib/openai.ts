/**
 * TEMPORARY — replaced by the provider abstraction in src/services/llm/.
 *
 * Kept only so the app keeps running during the migration. It carries two
 * bugs worth naming before they are removed:
 *
 *   1. It sends only the latest message, so the model has no memory of the
 *      conversation. Every reply is answered in isolation.
 *   2. `data.choices[0].message.content` assumes success. When the API
 *      returns an error object instead, this throws a TypeError that the
 *      original code swallowed and returned `undefined` from — which then
 *      got saved to the database as the assistant's reply.
 */
export async function getOpenAIAPIResponse(message: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== "string") {
    throw new Error("OpenAI response did not contain a message");
  }

  return reply;
}

export default getOpenAIAPIResponse;
