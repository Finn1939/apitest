export async function streamNvidiaReply(client, { messages, onDelta, abortSignal }) {
  const stream = await client.chat.completions.create({
    model: process.env.AI_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b",
    messages,
    max_tokens: 512,
    temperature: 1,
    top_p: 0.95,
    stream: true,
    chat_template_kwargs: { enable_thinking: false },
  }, { signal: abortSignal });

  let content = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      content += delta;
      onDelta(delta);
    }
  }
  return content;
}
