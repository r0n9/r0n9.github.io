package api

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"publisher/internal/config"
	"publisher/internal/generator"
	"publisher/internal/github"
)

// Server 封装 HTTP API 服务
type Server struct {
	cfg      *config.Config
	ghClient *github.Client
}

const (
	maxRequestBytes = 32 << 20
	maxImageBytes   = 10 << 20
	maxImageCount   = 20
	maxContentChars = 1_000_000
)

func chinaNow() time.Time {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.Now().UTC()
	}
	return time.Now().In(loc)
}

func allowedImageExtension(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif":
		return true
	default:
		return false
	}
}

// NewServer 创建 API 服务实例
func NewServer(cfg *config.Config, ghClient *github.Client) *Server {
	return &Server{
		cfg:      cfg,
		ghClient: ghClient,
	}
}

// JSONResponse 辅助写入 JSON 响应
func (s *Server) JSONResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// JSONError 辅助写入 JSON 错误响应
func (s *Server) JSONError(w http.ResponseWriter, status int, message string) {
	s.JSONResponse(w, status, map[string]any{
		"ok":    false,
		"error": message,
	})
}

// AuthMiddleware 权限校验中间件
func (s *Server) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ""
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		} else if secretHeader := r.Header.Get("X-Admin-Secret"); secretHeader != "" {
			token = secretHeader
		} else if cookie, err := r.Cookie("admin_secret"); err == nil {
			token = cookie.Value
		}

		if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminSecret)) != 1 {
			s.JSONError(w, http.StatusUnauthorized, "口令未提供或不正确，无权访问")
			return
		}

		next(w, r)
	}
}

// HandleAuthVerify 验证口令有效性
func (s *Server) HandleAuthVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.JSONError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.JSONError(w, http.StatusBadRequest, "解析请求参数失败")
		return
	}

	if subtle.ConstantTimeCompare([]byte(req.Secret), []byte(s.cfg.AdminSecret)) == 1 {
		http.SetCookie(w, &http.Cookie{
			Name:     "admin_secret",
			Value:    req.Secret,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   86400 * 30, // 30 天
		})
		s.JSONResponse(w, http.StatusOK, map[string]any{
			"ok":     true,
			"author": s.cfg.Author,
			"repo":   fmt.Sprintf("%s/%s", s.cfg.GithubOwner, s.cfg.GithubRepo),
			"branch": s.cfg.GithubBranch,
		})
	} else {
		s.JSONError(w, http.StatusUnauthorized, "口令错误")
	}
}

// HandlePublishMoment 处理动态发布请求
func (s *Server) HandlePublishMoment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.JSONError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(maxRequestBytes); err != nil {
		s.JSONError(w, http.StatusBadRequest, "解析表单数据失败: "+err.Error())
		return
	}

	content := strings.TrimSpace(r.FormValue("content"))
	if len([]rune(content)) > maxContentChars {
		s.JSONError(w, http.StatusRequestEntityTooLarge, "动态正文不能超过 1,000,000 个字符")
		return
	}
	author := strings.TrimSpace(r.FormValue("author"))
	if author == "" {
		author = s.cfg.Author
	}

	now := chinaNow()
	timestampPrefix := now.Format("2006-01-02-150405")

	var filesToCommit []github.FileToCommit
	var webImagePaths []string

	// 处理上传的图片
	formFiles := r.MultipartForm.File["images"]
	if len(formFiles) > maxImageCount {
		s.JSONError(w, http.StatusRequestEntityTooLarge, "最多上传 20 张图片")
		return
	}
	for i, fileHeader := range formFiles {
		if fileHeader.Size > maxImageBytes || !allowedImageExtension(fileHeader.Filename) {
			s.JSONError(w, http.StatusUnsupportedMediaType, "仅支持不超过 10 MB 的 PNG、JPG、WEBP、GIF 或 AVIF 图片")
			return
		}
		file, err := fileHeader.Open()
		if err != nil {
			s.JSONError(w, http.StatusInternalServerError, "打开上传文件失败: "+err.Error())
			return
		}
		fileBytes, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
		_ = file.Close()
		if err != nil {
			s.JSONError(w, http.StatusInternalServerError, "读取上传文件失败: "+err.Error())
			return
		}
		if len(fileBytes) > maxImageBytes {
			s.JSONError(w, http.StatusRequestEntityTooLarge, "单张图片不能超过 10 MB")
			return
		}

		ext := filepath.Ext(fileHeader.Filename)
		if ext == "" {
			ext = ".png"
		}
		cleanName := generator.SanitizeFilename(strings.TrimSuffix(fileHeader.Filename, ext))
		targetFilename := fmt.Sprintf("%s_%d_%s%s", timestampPrefix, i+1, cleanName, ext)
		repoImagePath := "static/images/moments/" + targetFilename
		webImagePath := "/images/moments/" + targetFilename

		filesToCommit = append(filesToCommit, github.FileToCommit{
			Path:     repoImagePath,
			Content:  fileBytes,
			IsBinary: true,
		})
		webImagePaths = append(webImagePaths, webImagePath)
	}

	// 生成动态 Markdown
	momentReq := generator.MomentRequest{
		Content: content,
		Author:  author,
	}
	mdPath, mdBytes, err := generator.GenerateMoment(momentReq, webImagePaths, s.cfg.Author, now)
	if err != nil {
		s.JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	filesToCommit = append(filesToCommit, github.FileToCommit{
		Path:     mdPath,
		Content:  mdBytes,
		IsBinary: false,
	})

	commitMsg := fmt.Sprintf("feat(moments): 发布随手记 (%s)", now.Format("2006-01-02 15:04"))
	commitURL, err := s.ghClient.CommitFiles(r.Context(), commitMsg, filesToCommit)
	if err != nil {
		s.JSONError(w, http.StatusInternalServerError, "同步至 GitHub 失败: "+err.Error())
		return
	}

	s.JSONResponse(w, http.StatusOK, map[string]any{
		"ok":         true,
		"commit_url": commitURL,
		"md_path":    mdPath,
		"images":     webImagePaths,
		"page_url":   s.cfg.SiteURL + "/moment/" + now.Format("2006-01-02-150405") + "/",
	})
}

// HandlePublishPost 处理长篇文章发布请求
func (s *Server) HandlePublishPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.JSONError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(maxRequestBytes); err != nil {
		s.JSONError(w, http.StatusBadRequest, "解析表单数据失败: "+err.Error())
		return
	}

	title := strings.TrimSpace(r.FormValue("title"))
	description := strings.TrimSpace(r.FormValue("description"))
	content := strings.TrimSpace(r.FormValue("content"))
	if len([]rune(title)) > 300 || len([]rune(description)) > 2_000 || len([]rune(content)) > maxContentChars {
		s.JSONError(w, http.StatusRequestEntityTooLarge, "标题、摘要或正文长度超出限制")
		return
	}
	draft := r.FormValue("draft") == "true"

	rawCategories := strings.TrimSpace(r.FormValue("categories"))
	var categories []string
	if rawCategories != "" {
		for _, cat := range strings.Split(rawCategories, ",") {
			cat = strings.TrimSpace(cat)
			if cat != "" {
				categories = append(categories, cat)
			}
		}
	}

	rawTags := strings.TrimSpace(r.FormValue("tags"))
	var tags []string
	if rawTags != "" {
		for _, tag := range strings.Split(rawTags, ",") {
			tag = strings.TrimSpace(tag)
			if tag != "" {
				tags = append(tags, tag)
			}
		}
	}

	now := chinaNow()
	timestampPrefix := now.Format("2006-01-02-150405")

	var filesToCommit []github.FileToCommit

	// 处理文章附带上传的插图
	formFiles := r.MultipartForm.File["images"]
	if len(formFiles) > maxImageCount {
		s.JSONError(w, http.StatusRequestEntityTooLarge, "最多上传 20 张图片")
		return
	}
	for i, fileHeader := range formFiles {
		if fileHeader.Size > maxImageBytes || !allowedImageExtension(fileHeader.Filename) {
			s.JSONError(w, http.StatusUnsupportedMediaType, "仅支持不超过 10 MB 的 PNG、JPG、WEBP、GIF 或 AVIF 图片")
			return
		}
		file, err := fileHeader.Open()
		if err != nil {
			s.JSONError(w, http.StatusInternalServerError, "打开上传文件失败: "+err.Error())
			return
		}
		fileBytes, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
		_ = file.Close()
		if err != nil {
			s.JSONError(w, http.StatusInternalServerError, "读取上传文件失败: "+err.Error())
			return
		}
		if len(fileBytes) > maxImageBytes {
			s.JSONError(w, http.StatusRequestEntityTooLarge, "单张图片不能超过 10 MB")
			return
		}

		ext := filepath.Ext(fileHeader.Filename)
		if ext == "" {
			ext = ".png"
		}
		cleanName := generator.SanitizeFilename(strings.TrimSuffix(fileHeader.Filename, ext))
		targetFilename := fmt.Sprintf("%s_%d_%s%s", timestampPrefix, i+1, cleanName, ext)
		repoImagePath := "static/images/" + targetFilename

		filesToCommit = append(filesToCommit, github.FileToCommit{
			Path:     repoImagePath,
			Content:  fileBytes,
			IsBinary: true,
		})
	}

	postReq := generator.PostRequest{
		Title:       title,
		Description: description,
		Categories:  categories,
		Tags:        tags,
		Draft:       draft,
		Content:     content,
	}

	mdPath, mdBytes, err := generator.GeneratePost(postReq, now)
	if err != nil {
		s.JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	filesToCommit = append(filesToCommit, github.FileToCommit{
		Path:     mdPath,
		Content:  mdBytes,
		IsBinary: false,
	})

	commitMsg := fmt.Sprintf("feat(posts): 发布新文章《%s》", title)
	if draft {
		commitMsg = fmt.Sprintf("chore(posts): 保存文章草稿《%s》", title)
	}

	commitURL, err := s.ghClient.CommitFiles(r.Context(), commitMsg, filesToCommit)
	if err != nil {
		s.JSONError(w, http.StatusInternalServerError, "同步至 GitHub 失败: "+err.Error())
		return
	}

	s.JSONResponse(w, http.StatusOK, map[string]any{
		"ok":         true,
		"commit_url": commitURL,
		"md_path":    mdPath,
		"title":      title,
	})
}
