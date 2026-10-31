package app

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/zhoushoujianwork/easyeda-agent/internal/protocol"
)

func TestWholeBoardActionsGetLongBudgets(t *testing.T) {
	for action, floor := range map[string]time.Duration{
		"pcb.pour.rebuild": pourRebuildBudget,
		"pcb.drc.check":    pcbDrcBudget,
		"pcb.beautify":     pcbBeautifyBudget,
		"pcb.route.auto":   pcbAutoRouteBudget,
	} {
		got := effectiveReadTimeout(action, nil, defaultActionTimeout)
		if want := floor + protocol.DispatchResponseGrace; got != want {
			t.Errorf("%s: default budget %v, want %v", action, got, want)
		}
		// A longer explicit request is kept, never cut back to the floor.
		if got := effectiveReadTimeout(action, nil, 10*time.Minute); got != 10*time.Minute {
			t.Errorf("%s: explicit 10m became %v", action, got)
		}
		// A deliberately short diagnostic deadline stays short.
		if got := effectiveReadTimeout(action, nil, 5*time.Second); got != 5*time.Second {
			t.Errorf("%s: short 5s became %v", action, got)
		}
	}
	if got := effectiveReadTimeout("pcb.line.create", nil, defaultActionTimeout); got != defaultActionTimeout {
		t.Errorf("ordinary action budget changed: %v", got)
	}
}

func TestPourRebuildIncompleteError(t *testing.T) {
	var stderr bytes.Buffer
	partial := []byte(`{"ok":true,"result":{"pours":4,"rebuilt":1,"failed":1,"complete":false,"pending":["c","d"]}}`)
	err := pourRebuildIncompleteError(partial, &stderr)
	if err == nil || !strings.Contains(err.Error(), "2 pour(s) pending") {
		t.Fatalf("partial run must fail, got %v", err)
	}
	if !strings.Contains(stderr.String(), "pour-rebuild --ids c,d") || !strings.Contains(stderr.String(), "2 of 4") {
		t.Fatalf("hint must give the follow-up command, got %q", stderr.String())
	}

	for name, body := range map[string]string{
		"complete":      `{"result":{"pours":2,"rebuilt":2,"complete":true,"pending":[]}}`,
		"old connector": `{"result":{"pours":2,"rebuilt":2}}`,
		"not json":      `oops`,
	} {
		stderr.Reset()
		if err := pourRebuildIncompleteError([]byte(body), &stderr); err != nil || stderr.Len() != 0 {
			t.Errorf("%s: want silent success, got err=%v stderr=%q", name, err, stderr.String())
		}
	}
}

func TestPourRebuildTimeoutHint(t *testing.T) {
	var stderr bytes.Buffer
	err := fmt.Errorf("dispatch: %w", context.DeadlineExceeded)
	if got := pourRebuildTimeoutHint(err, &stderr); got != err {
		t.Fatalf("hint must return the original error")
	}
	if !strings.Contains(stderr.String(), "do NOT resend") {
		t.Fatalf("timeout hint missing, got %q", stderr.String())
	}
	stderr.Reset()
	_ = pourRebuildTimeoutHint(fmt.Errorf("UNKNOWN_ACTION"), &stderr)
	if stderr.Len() != 0 {
		t.Fatalf("non-timeout error must not get the hint")
	}
}
