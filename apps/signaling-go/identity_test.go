package main

import (
	"reflect"
	"regexp"
	"testing"
)

func TestNormalizeDisplayName(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		want   string
		wantOK bool
	}{
		{"plain", "客厅的电脑", "客厅的电脑", true},
		{"trims", "  客厅 的电脑  ", "客厅 的电脑", true},
		{"strips control characters", "\x00\x07abc\t", "abc", true},
		{"strips tab then trims", "\t  x  ", "x", true},
		{"empty", "   ", "", false},
		{"control only", "\x01\x02", "", false},
		{"16 code points", "一二三四五六七八九十一二三四五六", "一二三四五六七八九十一二三四五六", true},
		{"17 code points", "一二三四五六七八九十一二三四五六七", "", false},
		{"16 emoji", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", true},
		{"17 emoji", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "", false},
		{"BOM trimmed", "\uFEFFabc", "abc", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := normalizeDisplayName(testCase.raw)
			if ok != testCase.wantOK || got != testCase.want {
				t.Fatalf("normalizeDisplayName(%q) = (%q, %v), want (%q, %v)", testCase.raw, got, ok, testCase.want, testCase.wantOK)
			}
		})
	}
}

func TestDefaultDisplayName(t *testing.T) {
	pattern := regexp.MustCompile(`^电脑 · [A-Z2-7]{4}$`)
	for index := 0; index < 20; index++ {
		name := defaultDisplayName(adminCaps())
		if !pattern.MatchString(name) {
			t.Fatalf("defaultDisplayName() = %q, want %q", name, pattern)
		}
	}
	if label := platformLabel("android"); label != "手机" {
		t.Fatalf("platformLabel(android) = %q", label)
	}
	if label := platformLabel("no-such-platform"); label != "设备" {
		t.Fatalf("platformLabel(unknown) = %q", label)
	}
}

func TestDedupeNames(t *testing.T) {
	got := dedupeNames([]string{"同名", "同名", "同名"})
	want := []string{"同名", "同名-2", "同名-3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeNames = %v, want %v", got, want)
	}

	// Admin first; case-sensitive.
	got = dedupeNames([]string{"Mac", "mac", "Mac"})
	want = []string{"Mac", "mac", "Mac-2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeNames = %v, want %v", got, want)
	}

	// Invalid candidates fall back to 设备.
	got = dedupeNames([]string{"   ", "\x01"})
	want = []string{"设备", "设备-2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeNames = %v, want %v", got, want)
	}

	// Suffixed names stay within 16 code points: 16 chars + "-2" truncates to 14 + suffix.
	long := "一二三四五六七八九十一二三四五六"
	got = dedupeNames([]string{long, long})
	if len([]rune(got[1])) != maxNameCodePoints {
		t.Fatalf("suffixed name has %d code points, want %d (%q)", len([]rune(got[1])), maxNameCodePoints, got[1])
	}
	if got[1] != "一二三四五六七八九十一二三四-2" {
		t.Fatalf("suffixed name = %q", got[1])
	}
}

func TestDedupeRenumbersAfterRemoval(t *testing.T) {
	// Same behaviour as memberInfos(): the second duplicate becomes the base name
	// once the first is gone.
	if got := dedupeNames([]string{"同名", "同名-2"}); !reflect.DeepEqual(got, []string{"同名", "同名-2"}) {
		t.Fatalf("dedupeNames = %v", got)
	}
	if got := dedupeNames([]string{"同名", "同名"}); !reflect.DeepEqual(got, []string{"同名", "同名-2"}) {
		t.Fatalf("dedupeNames = %v", got)
	}
}
