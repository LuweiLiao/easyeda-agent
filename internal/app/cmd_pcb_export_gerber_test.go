package app

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func gerberZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const (
	testGerber = "G04 EasyEDA*\n%FSLAX45Y45*%\n%MOMM*%\nD10*\nX0Y0D02*\nM02*\n"
	testDrill  = "M48\nMETRIC,LZ\nT01C0.3000\n%\nT01\nX1.0Y1.0\nM30\n"
)

func TestInspectGerberPackageClassifiesAndSorts(t *testing.T) {
	data := gerberZip(t, map[string]string{
		"Gerber_TopLayer.GTL":          testGerber,
		"Gerber_BoardOutlineLayer.GKO": testGerber,
		"Drill_PTH_Through.DRL":        testDrill,
		"How-to-order-PCB.txt":         "notes",
	})
	entries, files, err := inspectGerberPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, e := range entries {
		kinds = append(kinds, e.Name+"="+e.Kind)
		if len(e.SHA256) != 64 || e.Size != len(files[e.Name]) {
			t.Fatalf("bad entry %+v", e)
		}
	}
	want := "Drill_PTH_Through.DRL=drill,Gerber_BoardOutlineLayer.GKO=gerber,Gerber_TopLayer.GTL=gerber,How-to-order-PCB.txt=other"
	if got := strings.Join(kinds, ","); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestInspectGerberPackageRejects(t *testing.T) {
	cases := map[string][]byte{
		"not zip":       []byte("%FSLAX45Y45*%\nM02*\n"),
		"no drill":      gerberZip(t, map[string]string{"Gerber_BoardOutlineLayer.GKO": testGerber}),
		"no outline":    gerberZip(t, map[string]string{"Gerber_TopLayer.GTL": testGerber, "Drill.DRL": testDrill}),
		"truncated":     gerberZip(t, map[string]string{"Gerber_BoardOutlineLayer.GKO": "%FSLAX45Y45*%\nX0Y0D02*\n", "Drill.DRL": testDrill}),
		"drill no M30":  gerberZip(t, map[string]string{"Gerber_BoardOutlineLayer.GKO": testGerber, "Drill.DRL": "M48\nT01C0.3\n"}),
		"unsafe path":   gerberZip(t, map[string]string{"../Gerber_BoardOutlineLayer.GKO": testGerber, "Drill.DRL": testDrill}),
		"absolute path": gerberZip(t, map[string]string{"/x/Gerber_BoardOutlineLayer.GKO": testGerber, "Drill.DRL": testDrill}),
	}
	for name, data := range cases {
		if _, _, err := inspectGerberPackage(data); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestReadGerberArtifactRejectsMismatch(t *testing.T) {
	if _, err := readGerberArtifact(nil); err == nil {
		t.Fatal("nil response accepted")
	}
	res := &actionResult{OK: true, Result: map[string]any{"artifactId": "a", "size": float64(3)},
		Artifacts: []artifactRef{{ID: "b", Path: "x", Size: 3}}}
	if _, err := readGerberArtifact(res); err == nil {
		t.Fatal("artifact identity mismatch accepted")
	}
}
