# Decision Model Rerank

`lat search --rerank <url>` asks a decision model whether each candidate section answers the query, and orders the results by its answer. Without the flag, search is unchanged.

Hybrid search ranks by word overlap and vector similarity, and neither one reads the section the way a person does. On a real lat.md tree, a local decision model that reranked the candidates put the right section in the top three for 22 of 32 plain-English questions. Search alone managed 15.

Lat depends on no product here. The user supplies the URL of any decision model that speaks the format below. Only the `lat search` command takes the flag: the MCP `lat_search` tool, the prompt hook and `lat expand` keep the plain search order.

## The flag

The value must be an absolute `http:` or `https:` URL. [[src/fork/decision-model-rerank.ts#parseRerankUrl]] rejects anything else as an argument error before lat searches.

Two optional environment variables shape each request. `LAT_RERANK_MODEL` names the model and defaults to `default`. `LAT_RERANK_KEY`, when set, travels as `Authorization: Bearer <key>`.

## Candidates and order

A reranker can only promote a section that search retrieved, so lat retrieves more candidates than it prints.

[[src/fork/decision-model-rerank.ts#rerankCandidateCount]] asks search for the larger of the limit and ten. Lat then asks the decision model about each candidate, sorts them by the returned probability, and prints the top `limit`. Equal probabilities keep their search order. With `--debug`, each result shows its probability as `rerankProbability`.

## The request

Lat sends one `POST` per candidate with `Content-Type: application/json`, one after another. The decision model answers one request at a time, about 0.7 seconds each, so parallel requests would only queue.

```json
{
  "model": "default",
  "state": {
    "question": "<the search query>",
    "section": "<heading path>\n\n<section text, up to 1,200 characters>"
  },
  "questions": {
    "relevant": {
      "type": "noul",
      "instructions": "The question is what a reader wants to find in the project documentation. Does this documentation section directly answer the question?"
    }
  }
}
```

The heading path joins the section's headings with ` > `, for example `Architecture > Authentication`. The section text is the section's own body below its heading, cut at [[src/fork/decision-model-rerank.ts#RERANK_SECTION_TEXT_MAXIMUM_CHARACTERS]].

The answer reads `{"answers": {"relevant": {"noul": 0.88}}}`. The number is the probability of "yes", from 0 to 1. [[src/fork/decision-model-rerank.ts#askDecisionModel]] reads only that field.

## When the decision model fails

A reranker is an optional improvement, so it never fails the command.

A network error, an HTTP error, a malformed answer, or a request that outlasts [[src/fork/decision-model-rerank.ts#RERANK_REQUEST_TIMEOUT_MILLISECONDS]] stops the reranking. [[src/fork/decision-model-rerank.ts#rerankSearchMatches]] then writes one sentence to stderr and prints the plain search order for the whole query.

A partial order would mix probabilities with search ranks that do not compare, so lat discards every answer it already has. Search retrieves at least 50 candidates internally, so the first `limit` of the larger candidate set match a plain search exactly. Test spec: [[tests/fork-decision-model-rerank]].
