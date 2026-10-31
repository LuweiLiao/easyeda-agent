package app

// cli-tree — the whole command tree as JSON, for the MCP adapter.
//
// The MCP adapter exposes typed actions one per call, but 300+ CLI commands
// (apply, pcb dump --out, layout render, sch export-image, doc reload, ...)
// are composites or offline tools with no typed action. The adapter runs them
// through one generic tool; this command gives it every path, flag and example
// in one in-process walk instead of hundreds of `--help` subprocesses.

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

type cliTreeFlag struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Default string `json:"default,omitempty"`
	Usage   string `json:"usage"`
}

type cliTreeCommand struct {
	Path    []string      `json:"path"`
	Short   string        `json:"short"`
	Long    string        `json:"long,omitempty"`
	Example string        `json:"example,omitempty"`
	Use     string        `json:"use"`
	Flags   []cliTreeFlag `json:"flags,omitempty"`
}

func newCliTreeCmd(stdout io.Writer) *cobra.Command {
	var prefix string
	var long bool
	cmd := &cobra.Command{
		Use:    "cli-tree",
		Short:  "Print every runnable command with its flags as JSON (for the MCP adapter)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			want := strings.Fields(prefix)
			var out []cliTreeCommand
			var walk func(*cobra.Command)
			walk = func(c *cobra.Command) {
				if c.Hidden || c.Name() == "help" || c.Name() == "completion" {
					return
				}
				path := strings.Fields(c.CommandPath())[1:]
				if c.Runnable() && len(path) > 0 && hasPrefix(path, want) {
					row := cliTreeCommand{Path: path, Short: c.Short, Use: c.Use}
					if long {
						row.Long, row.Example = c.Long, c.Example
					}
					c.LocalFlags().VisitAll(func(f *pflag.Flag) {
						if f.Hidden || f.Name == "help" {
							return
						}
						row.Flags = append(row.Flags, cliTreeFlag{Name: f.Name, Type: f.Value.Type(), Default: f.DefValue, Usage: f.Usage})
					})
					out = append(out, row)
				}
				for _, child := range c.Commands() {
					walk(child)
				}
			}
			walk(cmd.Root())
			enc := json.NewEncoder(stdout)
			enc.SetIndent("", " ")
			return enc.Encode(map[string]any{"count": len(out), "commands": out})
		},
	}
	cmd.Flags().StringVar(&prefix, "prefix", "", `only commands under this path, e.g. "pcb layout"`)
	cmd.Flags().BoolVar(&long, "long", false, "include Long help and Example text")
	return cmd
}

func hasPrefix(path, want []string) bool {
	if len(want) > len(path) {
		return false
	}
	for i := range want {
		if path[i] != want[i] {
			return false
		}
	}
	return true
}
