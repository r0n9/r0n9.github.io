package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client 封装 GitHub REST API 调用
type Client struct {
	token      string
	owner      string
	repo       string
	branch     string
	httpClient *http.Client
}

// FileToCommit 表示要提交的文件
type FileToCommit struct {
	Path     string // 仓库相对路径，如 content/posts/xxx.md 或 static/images/xxx.png
	Content  []byte // 文件数据
	IsBinary bool   // 是否为二进制文件（如图片）
}

// NewClient 创建 GitHub API 客户端
func NewClient(token, owner, repo, branch string) *Client {
	return &Client{
		token:  token,
		owner:  owner,
		repo:   repo,
		branch: branch,
		httpClient: &http.Client{
			Timeout: 45 * time.Second,
		},
	}
}

// request 发送认证请求
func (c *Client) request(ctx context.Context, method, endpoint string, reqBody any, respBody any) error {
	var bodyReader io.Reader
	if reqBody != nil {
		data, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("json marshal error: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/%s%s", c.owner, c.repo, endpoint)
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return fmt.Errorf("create request error: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "r0n9-blog-publisher")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("network request error: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response error: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("github api [%s %s] failed (%d): %s", method, endpoint, resp.StatusCode, string(respBytes))
	}

	if respBody != nil && len(respBytes) > 0 {
		if err := json.Unmarshal(respBytes, respBody); err != nil {
			return fmt.Errorf("json unmarshal error: %w", err)
		}
	}

	return nil
}

// CommitFiles 通过 Git Data API 原子提交多个文件并推送到指定分支
func (c *Client) CommitFiles(ctx context.Context, message string, files []FileToCommit) (string, error) {
	if len(files) == 0 {
		return "", fmt.Errorf("没有需要提交的文件")
	}

	// 1. 获取目标分支当前的最顶层 Commit SHA
	var refResp struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := c.request(ctx, "GET", "/git/ref/heads/"+c.branch, nil, &refResp); err != nil {
		return "", fmt.Errorf("获取分支引用失败: %w", err)
	}
	latestCommitSHA := refResp.Object.SHA

	// 2. 获取该 Commit 对应的 Tree SHA
	var commitResp struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := c.request(ctx, "GET", "/git/commits/"+latestCommitSHA, nil, &commitResp); err != nil {
		return "", fmt.Errorf("获取 Commit Tree 失败: %w", err)
	}
	baseTreeSHA := commitResp.Tree.SHA

	// 3. 构造 Tree Entries（二进制创建 Blob，文本直接内嵌 content）
	type TreeEntry struct {
		Path    string `json:"path"`
		Mode    string `json:"mode"`
		Type    string `json:"type"`
		Content string `json:"content,omitempty"`
		SHA     string `json:"sha,omitempty"`
	}

	var treeEntries []TreeEntry

	for _, f := range files {
		if f.IsBinary {
			// 创建 Blob
			blobReq := map[string]string{
				"content":  base64.StdEncoding.EncodeToString(f.Content),
				"encoding": "base64",
			}
			var blobResp struct {
				SHA string `json:"sha"`
			}
			if err := c.request(ctx, "POST", "/git/blobs", blobReq, &blobResp); err != nil {
				return "", fmt.Errorf("上传文件 Blob [%s] 失败: %w", f.Path, err)
			}
			treeEntries = append(treeEntries, TreeEntry{
				Path: f.Path,
				Mode: "100644",
				Type: "blob",
				SHA:  blobResp.SHA,
			})
		} else {
			treeEntries = append(treeEntries, TreeEntry{
				Path:    f.Path,
				Mode:    "100644",
				Type:    "blob",
				Content: string(f.Content),
			})
		}
	}

	// 4. 创建新的 Git Tree
	createTreeReq := map[string]any{
		"base_tree": baseTreeSHA,
		"tree":      treeEntries,
	}
	var newTreeResp struct {
		SHA string `json:"sha"`
	}
	if err := c.request(ctx, "POST", "/git/trees", createTreeReq, &newTreeResp); err != nil {
		return "", fmt.Errorf("创建 Git Tree 失败: %w", err)
	}

	// 5. 创建新的 Commit
	createCommitReq := map[string]any{
		"message": message,
		"tree":    newTreeResp.SHA,
		"parents": []string{latestCommitSHA},
	}
	var newCommitResp struct {
		SHA string `json:"sha"`
	}
	if err := c.request(ctx, "POST", "/git/commits", createCommitReq, &newCommitResp); err != nil {
		return "", fmt.Errorf("创建 Git Commit 失败: %w", err)
	}

	// 6. 更新分支引用 HEAD 指向新 Commit
	updateRefReq := map[string]any{
		"sha":   newCommitResp.SHA,
		"force": false,
	}
	if err := c.request(ctx, "PATCH", "/git/refs/heads/"+c.branch, updateRefReq, nil); err != nil {
		return "", fmt.Errorf("更新分支 HEAD 失败: %w", err)
	}

	commitURL := fmt.Sprintf("https://github.com/%s/%s/commit/%s", c.owner, c.repo, newCommitResp.SHA)
	return commitURL, nil
}
