package app

import (
	"encoding/json"
	"time"

	"github.com/zhoushoujianwork/easyeda-agent/internal/protocol"
)

// These are connector-wait budgets, not the HTTP round trip. Keep the current
// wire contract (daemon subtracts response grace) explicit at this boundary.
const (
	documentOpenReadBudget  = 30 * time.Second
	schematicPinsReadBudget = 150 * time.Second
	pourOrderReadBudget     = 60 * time.Second
	// Whole-board actions. Under the 20s default a full re-pour (~54 pours on
	// GD32H757_FCU) or a DRC on a busy board timed out while still running,
	// and the caller could not tell whether it had landed. pour.rebuild now
	// stops on its own before the budget ends and returns `pending`.
	pourRebuildBudget = 180 * time.Second
	pcbDrcBudget      = 90 * time.Second
	pcbBeautifyBudget = 180 * time.Second
	// Stay below the MCP adapter's 300s process timeout.
	pcbAutoRouteBudget = 240 * time.Second
)

// All CLI dispatch paths converge in postAction, including Apply and layout.
// A deliberately short diagnostic deadline remains short; legacy 90s pin reads
// get the same floor as reads that previously inherited the default 20s.
func effectiveReadTimeout(action string, payload any, requested time.Duration) time.Duration {
	if requested < defaultActionTimeout {
		return requested
	}
	budget := time.Duration(0)
	switch action {
	case "schematic.attribute.move":
		// Before and after may each need a bounded 15s native visibility read.
		budget = 45 * time.Second
	case "document.open", "schematic.page.open":
		budget = documentOpenReadBudget
	case "pcb.pour.rebuild":
		budget = pourRebuildBudget
	case "pcb.drc.check":
		budget = pcbDrcBudget
	case "pcb.beautify":
		budget = pcbBeautifyBudget
	case "pcb.route.auto":
		budget = pcbAutoRouteBudget
	case "schematic.components.list":
		var flags struct {
			IncludePins bool `json:"includePins"`
		}
		data, err := json.Marshal(payload)
		if err == nil && json.Unmarshal(data, &flags) == nil && flags.IncludePins {
			budget = schematicPinsReadBudget
		}
	case "pcb.pour.create":
		var fields map[string]json.RawMessage
		data, err := json.Marshal(payload)
		if err == nil && json.Unmarshal(data, &fields) == nil && fields["priority"] != nil {
			// Four bounded source reads plus the awaited order setter/rebuild.
			budget = pourOrderReadBudget
		}
	}
	if budget > 0 && requested < budget+protocol.DispatchResponseGrace {
		requested = budget + protocol.DispatchResponseGrace
	}
	return schematicIdentityReadTimeout(action, payload, requested)
}
