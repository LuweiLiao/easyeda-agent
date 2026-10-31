package app

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestCliTreeListsRunnableCommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	root := newRootCmd(&stdout, &stderr)
	root.SetArgs([]string{"cli-tree"})
	if err := root.Execute(); err != nil {
		t.Fatalf("cli-tree: %v (%s)", err, stderr.String())
	}
	var tree struct {
		Count    int              `json:"count"`
		Commands []cliTreeCommand `json:"commands"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &tree); err != nil {
		t.Fatalf("decode: %v", err)
	}
	paths := map[string]cliTreeCommand{}
	for _, c := range tree.Commands {
		paths[strings.Join(c.Path, " ")] = c
	}
	for _, want := range []string{"apply", "pcb dump", "pcb layout render", "sch export-image", "pcb pour-rebuild", "doc reload"} {
		if _, ok := paths[want]; !ok {
			t.Errorf("missing %q", want)
		}
	}
	for _, hidden := range []string{"cli-tree", "help", "completion"} {
		if _, ok := paths[hidden]; ok {
			t.Errorf("%q must not be listed", hidden)
		}
	}
	var hasDryRun bool
	for _, f := range paths["apply"].Flags {
		hasDryRun = hasDryRun || f.Name == "dry-run"
	}
	if !hasDryRun || paths["apply"].Long != "" {
		t.Errorf("apply: want --dry-run flag and no Long text without --long")
	}
}

func TestCliTreePrefixAndLong(t *testing.T) {
	var stdout, stderr bytes.Buffer
	root := newRootCmd(&stdout, &stderr)
	root.SetArgs([]string{"cli-tree", "--prefix", "pcb dump", "--long"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	var tree struct {
		Commands []cliTreeCommand `json:"commands"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if len(tree.Commands) != 1 || strings.Join(tree.Commands[0].Path, " ") != "pcb dump" || tree.Commands[0].Long == "" {
		t.Fatalf("want exactly pcb dump with Long, got %+v", tree.Commands)
	}
}
