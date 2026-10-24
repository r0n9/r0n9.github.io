package generator

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// PostRequest 文章创建请求
type PostRequest struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Categories  []string `json:"categories"`
	Tags        []string `json:"tags"`
	Draft       bool     `json:"draft"`
	Content     string   `json:"content"`
}

// MomentRequest 动态创建请求
type MomentRequest struct {
	Content string `json:"content"`
	Author  string `json:"author"`
}

var invalidFilenameChars = regexp.MustCompile(`[/\\:*?"<>|]`)

// SanitizeFilename 清理文件名非法字符
func SanitizeFilename(name string) string {
	clean := invalidFilenameChars.ReplaceAllString(name, "")
	clean = strings.TrimSpace(clean)
	if clean == "" {
		clean = "post"
	}
	return clean
}

// GeneratePost 生成文章 Markdown 与仓库相对路径
func GeneratePost(req PostRequest, now time.Time) (path string, data []byte, err error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return "", nil, fmt.Errorf("文章标题不能为空")
	}

	dateStr := now.Format("2006-01-02T15:04:05+08:00")
	filePrefix := now.Format("2006_01_02")
	cleanTitle := SanitizeFilename(title)
	filename := fmt.Sprintf("%s_%s.md", filePrefix, cleanTitle)
	repoPath := "content/posts/" + filename

	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.WriteString(fmt.Sprintf("title: %q\n", title))
	buf.WriteString(fmt.Sprintf("date: %s\n", dateStr))
	buf.WriteString(fmt.Sprintf("draft: %t\n", req.Draft))

	if strings.TrimSpace(req.Description) != "" {
		buf.WriteString(fmt.Sprintf("description: %q\n", strings.TrimSpace(req.Description)))
	}

	if len(req.Categories) > 0 {
		buf.WriteString("categories:\n")
		for _, cat := range req.Categories {
			cat = strings.TrimSpace(cat)
			if cat != "" {
				buf.WriteString(fmt.Sprintf("  - %q\n", cat))
			}
		}
	} else {
		buf.WriteString("categories:\n  - \"技术\"\n")
	}

	if len(req.Tags) > 0 {
		buf.WriteString("tags:\n")
		for _, tag := range req.Tags {
			tag = strings.TrimSpace(tag)
			if tag != "" {
				buf.WriteString(fmt.Sprintf("  - %q\n", tag))
			}
		}
	} else {
		buf.WriteString("tags: []\n")
	}

	buf.WriteString("---\n\n")
	buf.WriteString(TransformStandaloneURLsToCards(strings.TrimSpace(req.Content)))
	buf.WriteString("\n")

	return repoPath, buf.Bytes(), nil
}

// GenerateMoment 生成动态 Markdown 与仓库相对路径
func GenerateMoment(req MomentRequest, imagePaths []string, defaultAuthor string, now time.Time) (path string, data []byte, err error) {
	content := strings.TrimSpace(req.Content)
	if content == "" && len(imagePaths) == 0 {
		return "", nil, fmt.Errorf("动态内容或配图不能均为空")
	}

	author := strings.TrimSpace(req.Author)
	if author == "" {
		author = defaultAuthor
	}
	if author == "" {
		author = "R0n9"
	}

	dateStr := now.Format("2006-01-02T15:04:05+08:00")
	filename := now.Format("2006-01-02-150405") + ".md"
	repoPath := "content/moments/" + filename

	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.WriteString("title: \"动态\"\n")
	buf.WriteString(fmt.Sprintf("date: %s\n", dateStr))
	buf.WriteString("draft: false\n")
	buf.WriteString(fmt.Sprintf("author: %q\n", author))

	if len(imagePaths) > 0 {
		buf.WriteString("images:\n")
		for _, p := range imagePaths {
			buf.WriteString(fmt.Sprintf("  - %q\n", p))
		}
	} else {
		buf.WriteString("images: []\n")
	}

	buf.WriteString("---\n\n")
	buf.WriteString(TransformStandaloneURLsToCards(content))
	buf.WriteString("\n")

	return repoPath, buf.Bytes(), nil
}
