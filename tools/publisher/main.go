package main

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"publisher/internal/api"
	"publisher/internal/config"
	"publisher/internal/github"
	"publisher/web"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[Error] 配置加载失败: %v", err)
	}

	ghClient := github.NewClient(
		cfg.GithubToken,
		cfg.GithubOwner,
		cfg.GithubRepo,
		cfg.GithubBranch,
	)

	server := api.NewServer(cfg, ghClient)
	mux := http.NewServeMux()

	// 注册 API 路由
	mux.HandleFunc("/api/auth/verify", server.HandleAuthVerify)
	mux.HandleFunc("/api/publish/moment", server.AuthMiddleware(server.HandlePublishMoment))
	mux.HandleFunc("/api/publish/post", server.AuthMiddleware(server.HandlePublishPost))

	// 注册嵌入式 Web 前端资源
	staticHandler := web.Handler()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		staticHandler.ServeHTTP(w, r)
	})

	maskedToken := "******"
	if len(cfg.GithubToken) > 8 {
		maskedToken = cfg.GithubToken[:4] + "..." + cfg.GithubToken[len(cfg.GithubToken)-4:]
	}

	fmt.Println("==================================================")
	fmt.Println("🚀 R0n9's Blog Publisher 服务已启动")
	fmt.Println("==================================================")
	fmt.Printf("• 监听端口:      :%s\n", cfg.Port)
	fmt.Printf("• 访问地址:      http://localhost:%s\n", cfg.Port)
	fmt.Printf("• 关联仓库:      %s/%s (分支: %s)\n", cfg.GithubOwner, cfg.GithubRepo, cfg.GithubBranch)
	fmt.Printf("• 默认作者:      %s\n", cfg.Author)
	fmt.Printf("• GitHub Token: %s\n", maskedToken)
	fmt.Printf("• 管理口令:      %s\n", strings.Repeat("*", len(cfg.AdminSecret)))
	fmt.Println("==================================================")

	addr := ":" + cfg.Port
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[Fatal] 服务器运行异常: %v", err)
	}
}
