package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed index.html style.css app.js
var embeddedFiles embed.FS

// Handler 返回静态前端文件的 HTTP Handler
func Handler() http.Handler {
	return http.FileServer(http.FS(embeddedFiles))
}

// GetFS 返回底层的 fs.FS 接口
func GetFS() fs.FS {
	return embeddedFiles
}
