export async function searchWeb(query, limit = 5) {
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1", skip_disambig: "1" });
  const response = await fetch(`https://api.duckduckgo.com/?${params}`);
  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }

  const data = await response.json();
  const results = [];

  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      snippet: data.AbstractText,
      url: data.AbstractURL || data.AbstractSource || "",
    });
  }

  collectRelated(data.RelatedTopics || [], results, limit);
  return results.slice(0, limit);
}

function collectRelated(topics, results, limit) {
  for (const topic of topics) {
    if (results.length >= limit) return;
    if (topic.Topics) {
      collectRelated(topic.Topics, results, limit);
    } else if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(" - ")[0].slice(0, 100),
        snippet: topic.Text,
        url: topic.FirstURL,
      });
    }
  }
}
