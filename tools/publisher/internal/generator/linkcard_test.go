package generator

import (
	"strings"
	"testing"
)

func TestStandaloneURLRegex(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"https://github.com/r0n9/camkeep", true},
		{"http://example.com/test?a=1&b=2", true},
		{"  https://github.com/r0n9/camkeep  ", true}, // trimmed in loop, should match
		{"欢迎访问 https://github.com/r0n9/camkeep", false},
		{"https://github.com/r0n9/camkeep 这个工具很好用", false},
		{"not-a-url", false},
	}

	for _, tt := range tests {
		matched := standaloneURLRegex.MatchString(strings.TrimSpace(tt.input))
		if matched != tt.expected {
			t.Errorf("input %q: expected match %v, got %v", tt.input, tt.expected, matched)
		}
	}
}
