CREATE TABLE `calls` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `moment` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `payload` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `url` varchar(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `response_code` int DEFAULT NULL,
  `response_message` varchar(5000) DEFAULT NULL,
  `attempt` tinyint NOT NULL DEFAULT '1',
  `error` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `moment` (`moment`),
  KEY `payload` (`payload`),
  KEY `response_code` (`response_code`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
