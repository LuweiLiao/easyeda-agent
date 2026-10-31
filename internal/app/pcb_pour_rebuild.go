package app

// pcb pour-rebuild — exit status and follow-up hints for the per-pour report.
//
// The connector stops a re-pour before the request budget ends and returns
// complete:false with the untouched ids in `pending` (extension
// pcb-pour-rebuild.ts). A partial answer must not look like success to a
// script, and a timeout must not invite a blind resend: the rebuild may still
// be running and a resend only queues another one behind it.

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type pourRebuildSummary struct {
	Pours    int      `json:"pours"`
	Rebuilt  int      `json:"rebuilt"`
	Failed   int      `json:"failed"`
	Complete *bool    `json:"complete"`
	Pending  []string `json:"pending"`
	NotFound []string `json:"notFound"`
}

// pourRebuildIncompleteError returns an error (non-zero exit) when the rebuild
// stopped early, printing the command that finishes the pending pours. An old
// connector without `complete` is treated as complete.
func pourRebuildIncompleteError(response []byte, stderr io.Writer) error {
	var envelope struct {
		Result pourRebuildSummary `json:"result"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil {
		return nil
	}
	r := envelope.Result
	if r.Complete == nil || *r.Complete {
		return nil
	}
	fmt.Fprintf(stderr, "hint: re-pour stopped before the budget ran out (%d of %d pours done, %d pending). Finish with:\n  easyeda pcb pour-rebuild --ids %s\n",
		r.Rebuilt+r.Failed, r.Pours, len(r.Pending), strings.Join(r.Pending, ","))
	return fmt.Errorf("pour rebuild incomplete: %d pour(s) pending", len(r.Pending))
}

// pourRebuildTimeoutHint decorates a timed-out re-pour.
func pourRebuildTimeoutHint(err error, stderr io.Writer) error {
	if err != nil && isTimeoutError(err) {
		fmt.Fprintln(stderr, "hint: re-pour did not answer in time and may still be running — do NOT resend. Wait, then read back (`pcb poured-list` / `pcb dump`). Narrow the next run with --nets or --ids.")
	}
	return err
}
