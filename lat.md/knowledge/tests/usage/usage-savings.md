---
lat:
  require-code-mention: true
---

# Usage Savings

Tests in `tests/usage-savings.test.ts` for `src/fork/usage/savings.ts`.

They build a fixture `lat.md` directory in a temporary git repository, commit it, and feed the aggregation usage events that carry the commit as their `git_head`. The document bytes come from the snapshot of that commit. None reads the real project graph.

The contribution loads the snapshots before the rows are built, so the first summary already shows the numbers.

## A section read saves its document's bytes minus bytes_out

A section read saves the bytes of the whole document that holds the section, taken from the snapshot at the event's `git_head`, minus the `bytes_out` of the event.

## A hook event adds injected cost and no saving

A hook-injected event, even one with a `section_id`, adds its `injected_bytes` to the cost. It adds nothing to the saved bytes and is not a section read.

## Injected bytes are subtracted per session

The net of a session is its saved tokens minus the tokens of the bytes its hooks injected. A session row does not include the injections of another session.

## The range brackets the point estimate

The estimate gives a low, a point and a high count of tokens, worked out at read time.

The low pairs the fewest saved tokens with the most injected tokens, and the high pairs the most saved with the fewest injected. So low is at most point and point is at most high, also when the net is negative.

## Every result carries method_version and its inputs

The result has `method_version`, the correlation label, the three bytes-per-token ratios, the count of section reads, the saved bytes and injected bytes as known and unknown counts, and the reasons for unknown reads.

## An unknown input gives null with a reason, never zero

A read with no `git_head`, no snapshot for its head, a section missing from the snapshot, or no `bytes_out` is unknown. It is never counted as zero saved bytes.

When the reads are all unknown, or the hook events are all unknown, the net is null and the result says why. A side with no events counts as zero. A side that is partly known covers its known values and reports the unknown count.

## A saving below zero is kept

When `bytes_out` is more than the bytes of the document, the saving of that read is negative and stays negative.

## Rows carry the estimate

Every agent, session and issue row has `net_tokens_saved` set to the point estimate of its own events. A row whose inputs are all unknown has null and `net_tokens_saved_reason`. Each row also has its `injected_bytes`.
