package generator

import (
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	standaloneURLRegex = regexp.MustCompile(`^https?://[^\s<>"'()]+$`)
	ogTitleRegex       = regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']`)
	ogTitleRevRegex    = regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']`)
	titleRegex         = regexp.MustCompile(`(?i)<title[^>]*>([^<]+)</title>`)
	ogDescRegex        = regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["'](?:og:description|description|twitter:description)["'][^>]+content=["']([^"']+)["']`)
	ogDescRevRegex     = regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description|twitter:description)["']`)
	ogImageRegex       = regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']`)
	ogImageRevRegex    = regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']`)
	ogSiteRegex        = regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)["']`)
	ogSiteRevRegex     = regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:site_name["']`)
)

// URLMetadata 包含网页 OpenGraph 与基本元数据
type URLMetadata struct {
	URL   string
	Title string
	Desc  string
	Image string
	Site  string
}

func fetchURLMetadata(rawURL string) *URLMetadata {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	hostname := parsed.Hostname()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return &URLMetadata{URL: rawURL, Title: hostname, Site: hostname}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Do(req)
	if err != nil {
		return &URLMetadata{URL: rawURL, Title: hostname, Site: hostname}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return &URLMetadata{URL: rawURL, Title: hostname, Site: hostname}
	}

	// 读取前 150KB 的 HTML 数据（足够解析 head）
	lr := io.LimitReader(resp.Body, 150*1024)
	bodyBytes, err := io.ReadAll(lr)
	if err != nil {
		return &URLMetadata{URL: rawURL, Title: hostname, Site: hostname}
	}
	headHTML := string(bodyBytes)

	findMeta := func(re1, re2 *regexp.Regexp) string {
		if m := re1.FindStringSubmatch(headHTML); len(m) > 1 {
			return m[1]
		}
		if m := re2.FindStringSubmatch(headHTML); len(m) > 1 {
			return m[1]
		}
		return ""
	}

	title := findMeta(ogTitleRegex, ogTitleRevRegex)
	if title == "" {
		if m := titleRegex.FindStringSubmatch(headHTML); len(m) > 1 {
			title = strings.TrimSpace(m[1])
		}
	}

	desc := findMeta(ogDescRegex, ogDescRevRegex)
	image := findMeta(ogImageRegex, ogImageRevRegex)
	site := findMeta(ogSiteRegex, ogSiteRevRegex)
	if site == "" {
		site = hostname
	}

	if image != "" && !strings.HasPrefix(image, "http://") && !strings.HasPrefix(image, "https://") {
		if refURL, err := url.Parse(image); err == nil {
			image = parsed.ResolveReference(refURL).String()
		}
	}

	cleanStr := func(s string) string {
		s = html.UnescapeString(s)
		return strings.TrimSpace(strings.Join(strings.Fields(s), " "))
	}

	title = cleanStr(title)
	if title == "" {
		title = hostname
	}
	desc = cleanStr(desc)
	site = cleanStr(site)
	if site == "" {
		site = hostname
	}

	return &URLMetadata{
		URL:   rawURL,
		Title: title,
		Desc:  desc,
		Image: image,
		Site:  site,
	}
}

// TransformStandaloneURLsToCards 检测并转换独占一行的独立 URL 为书签卡片短代码 (100% 静态保存到 Markdown)
func TransformStandaloneURLsToCards(content string) string {
	lines := strings.Split(content, "\n")
	modified := false
	type candidate struct {
		index int
		url   string
	}
	var candidates []candidate
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(candidates) < 20 && standaloneURLRegex.MatchString(trimmed) {
			candidates = append(candidates, candidate{index: i, url: trimmed})
		}
	}

	for start := 0; start < len(candidates); start += 3 {
		end := start + 3
		if end > len(candidates) {
			end = len(candidates)
		}
		var wg sync.WaitGroup
		var mu sync.Mutex
		for _, item := range candidates[start:end] {
			item := item
			wg.Add(1)
			go func() {
				defer wg.Done()
				meta := fetchURLMetadata(item.url)
				if meta == nil {
					return
				}
				esc := func(s string) string { return strings.ReplaceAll(s, `"`, `&quot;`) }
				var card strings.Builder
				card.WriteString(fmt.Sprintf(`{{< linkcard url=%q title=%q`, meta.URL, esc(meta.Title)))
				if meta.Desc != "" {
					card.WriteString(fmt.Sprintf(` desc=%q`, esc(meta.Desc)))
				}
				if meta.Site != "" {
					card.WriteString(fmt.Sprintf(` site=%q`, esc(meta.Site)))
				}
				if meta.Image != "" {
					card.WriteString(fmt.Sprintf(` image=%q`, esc(meta.Image)))
				}
				card.WriteString(` >}}`)
				mu.Lock()
				lines[item.index] = card.String()
				modified = true
				mu.Unlock()
			}()
		}
		wg.Wait()
	}

	if modified {
		return strings.Join(lines, "\n")
	}
	return content
}
