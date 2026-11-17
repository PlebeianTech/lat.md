# Decision Model Rerank

`lat search --rerank <url>` asks a decision model whether each candidate section answers the query, and orders the results by its answer. Without the flag, search is unchanged.

Hybrid search ranks by word overlap and vector similarity, and neither one reads the section the way a person does. In one measurement on a private project's 172-page lat.md tree, with 32 hand-written questions that this repository does not include, a local decision model put the right section in the top three for 22 questions and search alone for 15.

Lat depends on no product here. The user supplies the URL of any decision model that speaks the format below. Only the `lat search` command takes the flag: the MCP `lat_search` tool and the prompt hook keep the plain search order.

## The flag

The value must be an absolute `http:` or `https:` URL. [[src/fork/decision-model-rerank.ts#parseRerankUrl]] rejects anything else as an argument error before lat searches. It also rejects a URL that carries a user name or password, because the key belongs in `LAT_RERANK_KEY`.

Two optional environment variables, listed under [[cli#search]], shape each request. One server can host several decision models, so the model name is a setting. A key in an environment variable stays out of the URL, shell history and process lists. A key with a space, a line break or any character outside printable ASCII fails the rerank before any request, and the warning never shows the key.

## Candidates and order

A reranker can only promote a section that search retrieved, so lat retrieves more candidates than it prints.

[[src/fork/decision-model-rerank.ts#rerankCandidateCount]] asks search for the larger of the limit and ten. Lat then asks the decision model about each candidate, sorts them by the returned probability, and prints the top `limit`. Equal probabilities keep their search order. With `--debug`, each result shows its probability as `rerankProbability`.

## The request

Lat sends one `POST` per candidate with `Content-Type: application/json`, one after another. It never follows a redirect.

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

A network error, an HTTP error, a redirect, a malformed answer, or a request that outlasts [[src/fork/decision-model-rerank.ts#RERANK_REQUEST_TIMEOUT_MILLISECONDS]] stops the reranking. [[src/fork/decision-model-rerank.ts#rerankSearchMatches]] then writes one sentence to stderr and prints the plain search order for the whole query.

A partial order would mix probabilities with search ranks that do not compare, so lat discards every answer it already has. Search retrieves at least 50 candidates internally, so the first `limit` of the larger candidate set match a plain search exactly. Test spec: [[tests/fork-decision-model-rerank]].
