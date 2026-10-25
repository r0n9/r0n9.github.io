package config

import (
	"bufio"
	"errors"
	"os"
	"strings"
)

// Config 存储应用配置
type Config struct {
	GithubToken  string
	AdminSecret  string
	Port         string
	GithubOwner  string
	GithubRepo   string
	GithubBranch string
	Author       string
	SiteURL      string
}

// loadEnvFile 自动尝试加载 .env 文件（纯 Go 标准库，无外部依赖）
func loadEnvFile(paths ...string) {
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				val := strings.TrimSpace(parts[1])
				// 去除外层单双引号
				if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
					val = val[1 : len(val)-1]
				}
				// 仅在环境变量未被预设时注入
				if os.Getenv(key) == "" {
					_ = os.Setenv(key, val)
				}
			}
		}
		_ = f.Close()
		break // 优先加载找到的第一个 .env
	}
}

// Load 从环境变量及 .env 加载配置
func Load() (*Config, error) {
	// 尝试自动寻找并加载 .env（支持在 tools/publisher 目录或项目根目录下运行）
	loadEnvFile(".env", "tools/publisher/.env", "../.env")

	cfg := &Config{
		GithubToken:  strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		AdminSecret:  strings.TrimSpace(os.Getenv("ADMIN_SECRET")),
		Port:         strings.TrimSpace(os.Getenv("PORT")),
		GithubBranch: strings.TrimSpace(os.Getenv("GITHUB_BRANCH")),
		Author:       strings.TrimSpace(os.Getenv("AUTHOR")),
		SiteURL:      strings.TrimRight(strings.TrimSpace(os.Getenv("SITE_URL")), "/"),
	}

	if cfg.Port == "" {
		cfg.Port = "13133"
	}
	if cfg.GithubBranch == "" {
		cfg.GithubBranch = "master"
	}
	if cfg.Author == "" {
		cfg.Author = "R0n9"
	}
	if cfg.SiteURL == "" {
		cfg.SiteURL = "https://r0n9.github.io"
	}

	repoFull := strings.TrimSpace(os.Getenv("GITHUB_REPO"))
	if repoFull == "" {
		repoFull = "r0n9/r0n9.github.io"
	}
	parts := strings.Split(repoFull, "/")
	if len(parts) == 2 {
		cfg.GithubOwner = parts[0]
		cfg.GithubRepo = parts[1]
	} else {
		return nil, errors.New("GITHUB_REPO 格式应为 owner/repo (例如 r0n9/r0n9.github.io)")
	}

	if cfg.GithubToken == "" {
		return nil, errors.New("未检测到环境变量 GITHUB_TOKEN，请配置具有写入权限的 GitHub 个人访问令牌")
	}
	if cfg.AdminSecret == "" {
		return nil, errors.New("未检测到环境变量 ADMIN_SECRET，请配置 Web 后台管理密码")
	}

	return cfg, nil
}
