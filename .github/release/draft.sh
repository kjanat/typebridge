#!/usr/bin/env bash
set -euo pipefail

case "${1}" in
	prepare)
		: "${TAG:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_OUTPUT:?}"
		sha=$(git rev-parse HEAD)
		git merge-base --is-ancestor "${sha}" origin/master
		version=${TAG#v}
		jq -e '
      .workspaces | length > 0 and all(.[]; test("^[a-z][a-z0-9-]*$"))
    ' package.json
		package_list=$(jq -er '.workspaces[]' package.json)
		while IFS= read -r package; do
			jq -e --arg name "@kjanat/tsc-${package}" --arg version "${version}" \
				'.name == $name and .version == $version' "${package}/package.json"
		done <<<"${package_list}"
		release=$(jq -cn --arg tag "${TAG}" --arg version "${version}" --arg sha "${sha}" \
			--argjson run "${GITHUB_RUN_ID}" --slurpfile project package.json \
			'{tag: $tag, version: $version, sha: $sha, run: $run, packages: $project[0].workspaces, prerelease: ($version | split("+")[0] | contains("-"))}')
		existing=$(gh release list --limit 1000 --json tagName,isDraft | jq -c --arg tag "${TAG}" 'map(select(.tagName == $tag))')
		if [[ "${existing}" == '[]' ]]; then
			args=("${TAG}" --draft --verify-tag --generate-notes --title "${TAG}")
			prerelease=$(jq -r '.prerelease' <<<"${release}")
			if [[ "${prerelease}" == true ]]; then args+=(--prerelease); fi
			gh release create "${args[@]}"
		else
			jq -e 'length == 1 and .[0].isDraft' <<<"${existing}"
		fi
		printf 'release=%s\n' "${release}" >>"${GITHUB_OUTPUT}"
		;;
	attach | verify)
		: "${RELEASE:?}"
		tag=$(jq -er '.tag' <<<"${RELEASE}")
		sha=$(git rev-parse HEAD)
		expected_sha=$(jq -er '.sha' <<<"${RELEASE}")
		[[ "${sha}" == "${expected_sha}" ]]
		cd artifacts
		sha256sum -c ./*.sha256
		package_list=$(jq -er '.packages[]' <<<"${RELEASE}")
		mapfile -t packages <<<"${package_list}"
		version=$(jq -er '.version' <<<"${RELEASE}")
		archives=()
		for package in "${packages[@]}"; do
			tar -xOf "${package}.tgz" package/package.json \
				| jq -e --arg name "@kjanat/tsc-${package}" --arg version "${version}" \
					'.name == $name and .version == $version'
			archives+=("${package}.tgz")
		done
		jq . <<<"${RELEASE}" >release.json
		sha256sum -- "${archives[@]}" release.json >SHA256SUMS
		sha256sum -c SHA256SUMS
		if [[ "${1}" == attach ]]; then
			: "${GITHUB_STEP_SUMMARY:?}"
			gh release view "${tag}" --json isDraft --jq '.isDraft' | jq -e '. == true'
			gh release upload "${tag}" "${archives[@]}" SHA256SUMS release.json --clobber
			printf 'Draft ready for review: %s\n' "${tag}" >>"${GITHUB_STEP_SUMMARY}"
		fi
		;;
	*)
		printf 'Usage: draft.sh prepare|verify|attach\n' >&2
		exit 1
		;;
esac
