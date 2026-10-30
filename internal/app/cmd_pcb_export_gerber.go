package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	maxGerberBytes        = 20 << 20
	maxGerberEntries      = 512
	maxGerberEntryBytes   = 64 << 20
	maxGerberExpandedSize = 256 << 20
)

var gerberOutlineName = regexp.MustCompile(`(?i)(boardoutline|edge_cuts|\.gko$|\.gm1$)`)

// gerberEntry is one file of the exported fabrication package.
type gerberEntry struct {
	Name   string `json:"name"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
	Kind   string `json:"kind"` // gerber | drill | other
}

func newPcbExportGerberCmd(cfg *appConfig, window *string, stdout, stderr io.Writer) *cobra.Command {
	var out, name string
	c := &cobra.Command{
		Use:   "export-gerber",
		Short: "Export the PCB fabrication package (Gerber + drill) with archive and syntax checks",
		Long: `Export the active PCB through official beta getGerberFile with the host's one-click
defaults (mm, 4:5, layers actually used + drill layers, JLC objects) — the package
the editor's 一键导出 hands the fab. Read-only: no save, no DRC, no design change.

Requires a NEW --out directory. It keeps the official ZIP byte for byte, then checks
SHA-256 and size, safe archive paths and expansion limits, that every Gerber is
RS-274X (%FS … M02*) and every drill file Excellon (M48 … M30), and that a board
outline layer is present. On success it extracts the files to <out>/files and writes
manifest.json (status export-verified). A failed check keeps the ZIP and response as
evidence and writes no manifest. export-verified is NOT a manufacturing check: run
independent Gerber checks (clearance, outline, drills, mask) on <out>/files.`,
		Args: cobra.NoArgs,
		Example: `  easyeda pcb export-gerber --project <uuid> --out ./fab/gerber-20261030
  easyeda pcb export-gerber --project <uuid> --doc <pcb-uuid> --name FCU --out ./fab/rev-b`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if out == "" {
				return fmt.Errorf("a new --out directory is required")
			}
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			if err := os.Mkdir(out, 0o755); err != nil {
				return fmt.Errorf("--out must be new: %w", err)
			}
			writeJSON := func(file string, v any) error {
				b, err := json.MarshalIndent(v, "", "  ")
				if err != nil {
					return err
				}
				return os.WriteFile(filepath.Join(out, file), append(b, '\n'), 0o644)
			}
			payload := map[string]any{}
			if name != "" {
				payload["fileName"] = name
			}
			fmt.Fprintln(stderr, "Exporting official Gerber package (up to 180 seconds)…")
			res, err := requestActionTimed(cfg, "pcb.export.gerber", *window, payload, 180*time.Second)
			if res != nil {
				if e := writeJSON("export-response.json", res); e != nil {
					return e
				}
			}
			if err != nil {
				return err
			}
			if res.Context == nil || res.Context.DocumentType != "pcb" || res.Context.DocumentUUID == "" {
				return fmt.Errorf("export response does not name a PCB document")
			}
			data, err := readGerberArtifact(res)
			if err != nil {
				return err
			}
			zipName := "gerber.zip"
			if err := os.WriteFile(filepath.Join(out, zipName), data, 0o644); err != nil {
				return err
			}
			entries, files, err := inspectGerberPackage(data)
			if err != nil {
				return fmt.Errorf("%w (official file kept at %s)", err, filepath.Join(out, zipName))
			}
			for _, e := range entries {
				dst := filepath.Join(out, "files", filepath.FromSlash(e.Name))
				if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(dst, files[e.Name], 0o644); err != nil {
					return err
				}
			}
			counts := map[string]int{}
			outline := []string{}
			for _, e := range entries {
				counts[e.Kind]++
				if e.Kind == "gerber" && gerberOutlineName.MatchString(e.Name) {
					outline = append(outline, e.Name)
				}
			}
			manifest := map[string]any{"status": "export-verified", "manufacturingVerified": false,
				"file": zipName, "filesDir": "files", "artifactSha256": res.Artifacts[0].SHA256,
				"artifactSize": len(data), "nativeFileName": res.Result["fileName"],
				"projectUuid": res.Context.ProjectUUID, "projectName": res.Context.ProjectName,
				"documentUuid": res.Context.DocumentUUID, "windowId": res.WindowID,
				"options": "host-one-click-defaults", "counts": counts, "outline": outline,
				"files": entries, "capturedAt": time.Now().UTC().Format(time.RFC3339Nano)}
			if err := writeJSON("manifest.json", manifest); err != nil {
				return err
			}
			return json.NewEncoder(stdout).Encode(manifest)
		},
	}
	c.Flags().StringVar(&out, "out", "", "new output directory for the official ZIP, extracted files, response and manifest (required)")
	c.Flags().StringVar(&name, "name", "", "basename passed to the host (default gerber)")
	return c
}

// readGerberArtifact loads the single persisted artifact and checks it against
// the daemon's size/hash and the connector's reported identity.
func readGerberArtifact(res *actionResult) ([]byte, error) {
	if res == nil || !res.OK || len(res.Artifacts) != 1 {
		return nil, fmt.Errorf("Gerber export returned no single artifact")
	}
	a := res.Artifacts[0]
	if a.Path == "" || a.Size <= 0 || a.Size > maxGerberBytes || res.Result["artifactId"] != a.ID {
		return nil, fmt.Errorf("Gerber artifact size/path/identity invalid")
	}
	data, err := os.ReadFile(a.Path)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != a.Size || res.Result["size"] != float64(len(data)) || sha256Hex(data) != a.SHA256 {
		return nil, fmt.Errorf("Gerber artifact size/hash mismatch")
	}
	return data, nil
}

// inspectGerberPackage opens the official ZIP and classifies every file. It
// fails on unsafe or oversized archives, on a Gerber/drill file whose syntax is
// broken, and on a package without Gerber, drill or board-outline content.
func inspectGerberPackage(data []byte) ([]gerberEntry, map[string][]byte, error) {
	if !bytes.HasPrefix(data, []byte("PK")) {
		return nil, nil, fmt.Errorf("Gerber export is not a ZIP package")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, fmt.Errorf("Gerber ZIP unreadable: %w", err)
	}
	if len(z.File) > maxGerberEntries {
		return nil, nil, fmt.Errorf("too many Gerber archive entries")
	}
	entries := []gerberEntry{}
	files := map[string][]byte{}
	var total uint64
	for _, f := range z.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if strings.Contains(f.Name, "\\") || strings.HasPrefix(f.Name, "/") || strings.Contains("/"+f.Name+"/", "/../") || strings.Contains(f.Name, ":") {
			return nil, nil, fmt.Errorf("unsafe Gerber archive path %q", f.Name)
		}
		clean := filepath.ToSlash(filepath.Clean(f.Name))
		if _, dup := files[clean]; dup || f.UncompressedSize64 > maxGerberEntryBytes {
			return nil, nil, fmt.Errorf("duplicate or oversized Gerber archive entry %q", f.Name)
		}
		total += f.UncompressedSize64
		if total > maxGerberExpandedSize {
			return nil, nil, fmt.Errorf("Gerber archive expands beyond 256 MiB")
		}
		r, err := f.Open()
		if err != nil {
			return nil, nil, err
		}
		b, err := io.ReadAll(io.LimitReader(r, maxGerberEntryBytes+1))
		r.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("Gerber archive entry %q: %w", f.Name, err)
		}
		if len(b) > maxGerberEntryBytes {
			return nil, nil, fmt.Errorf("Gerber archive entry %q exceeds limit", f.Name)
		}
		kind, err := classifyFabFile(clean, b)
		if err != nil {
			return nil, nil, err
		}
		files[clean] = b
		entries = append(entries, gerberEntry{Name: clean, Size: len(b), SHA256: sha256Hex(b), Kind: kind})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	var gerbers, drills, outlines int
	for _, e := range entries {
		switch e.Kind {
		case "gerber":
			gerbers++
			if gerberOutlineName.MatchString(e.Name) {
				outlines++
			}
		case "drill":
			drills++
		}
	}
	if gerbers == 0 || drills == 0 || outlines == 0 {
		return nil, nil, fmt.Errorf("Gerber package incomplete: %d Gerber, %d drill, %d board-outline files", gerbers, drills, outlines)
	}
	return entries, files, nil
}

// classifyFabFile names a file gerber/drill/other from its content, not its
// extension. A file that starts like Gerber or Excellon must also end like one.
func classifyFabFile(name string, b []byte) (string, error) {
	head := b
	if len(head) > 4096 {
		head = head[:4096]
	}
	text := string(b)
	switch {
	case bytes.Contains(head, []byte("%FS")):
		if !strings.Contains(text, "M02*") {
			return "", fmt.Errorf("Gerber file %q has no M02* end-of-file", name)
		}
		return "gerber", nil
	case bytes.HasPrefix(bytes.TrimSpace(head), []byte("M48")) || bytes.Contains(head, []byte("\nM48")):
		if !strings.Contains(text, "M30") {
			return "", fmt.Errorf("drill file %q has no M30 end-of-program", name)
		}
		return "drill", nil
	}
	return "other", nil
}
